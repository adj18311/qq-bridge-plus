// t32 — attach the pictures in a QQ-space post as DSH IMAGE blocks, not just URLs.
//
// WHY THIS MODULE EXISTS
// ---------------------
// The read chain already returns image URLs (`posts[].images`, allowlisted for http/https by the
// projection). A model cannot fetch them, and the agent said so in as many words. So the plugin
// loads a few of them itself and hands them over as attachments — the same mechanism DSH's own
// `read_image` uses.
//
// WHY IT IS A SEPARATE MODULE AND NOT PART OF `native-tool.mjs`
// ------------------------------------------------------------
// Everything here touches the network and an attachment service. Keeping it out of the tool
// factory means the tool can be registered with NO network path at all, and the whole load is one
// injectable dependency: tests pass a fake `fetchImage`, production passes the platform's fetch.
//
// THE QUOTA IS THE DESIGN (not a detail)
// --------------------------------------
// A 306-post account, three pictures per post, would be hundreds of attachments in one tool call.
// So the budget is fixed and small:
//   · AT MOST ONE POST is inspected (the newest with pictures) — pictures from older posts are the
//     caller's business, not this layer's;
//   · AT MOST THREE images are attached per call;
//   · each download gets 10 s and is abandoned above 8 MiB, checked WHILE reading so an oversized
//     body is never buffered;
//   · a failure of ANY kind (network, timeout, size, unrecognised bytes, attachment service) simply
//     skips that image. Nothing retries, nothing throws, nothing is reported as an error.
//
// WHY THE MEDIA TYPE COMES FROM MAGIC BYTES
// -----------------------------------------
// `Content-Type` is a claim by the server. The attachment service will happily store whatever it is
// told and hand it back to a model as an image, so the type has to be derived from the bytes:
// JPEG `ff d8 ff`, PNG `89 50 4e 47`, WEBP `RIFF....WEBP`, GIF `47 49 46 38`. Anything else is
// skipped — an attachment whose declared type does not match its content is worse than no image.

/** At most this many images per tool call. */
const MAX_IMAGES = 3;
// HOW MANY POSTS CONTRIBUTE PICTURES: exactly one — the newest that has any.
//
// This is enforced STRUCTURALLY rather than by a counter: `selectImageUrls` below keeps a single
// `chosen` post and only replaces it with a newer one, so there is no code path that could
// collect pictures from two posts. All posts are SCANNED (that is how "newest" is determined
// without trusting the response order), and only the winner contributes URLs.
// A TOTAL budget across all images, not per image. Three sequential 10 s downloads would block a
// successful read for up to 30 s — long enough that the caller's own turn timeout fires while the
// text answer was already in hand. The whole attachment step therefore shares one deadline.
const TOTAL_DOWNLOAD_BUDGET_MS = 12_000;
/** Per-image ceiling. Bounded by the total budget above, so it is never the binding constraint. */
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** How much of a body is read for the magic-byte check before the full read continues. */
const SNIFF_BYTES = 12;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Identify an image by its MAGIC BYTES. `Content-Type` is never consulted.
 *
 * @param {Buffer} bytes at least a few bytes of the body.
 * @returns {'image/jpeg'|'image/png'|'image/webp'|'image/gif'|null} `null` when unrecognised,
 *   and `null` means "skip this image" — never "guess".
 */
export function sniffImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return null;
}

/**
 * Which URLs this layer is willing to fetch.
 *
 * The input is `posts[].images`, which the projection has ALREADY restricted to http/https. This
 * second check is not redundant paranoia: it is what keeps the rule true even if a future change
 * loosens the projection, and it is the only place that can bound the SIZE of the value. A model
 * cannot inject a URL here — the list comes from the dispatch result, never from the arguments.
 */
function isFetchableImageUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Collect the candidate URLs: the newest post's images, capped.
 *
 * `posts` is ordered newest-first by the read chain, but this does not rely on it — it picks the
 * post with the greatest `time` among those that actually carry pictures, so a reordered response
 * cannot move the pictures to an older post. It reads `images` with a property DESCRIPTOR (the
 * repo's convention against hostile getters) and ignores anything that is not an array of strings.
 *
 * @returns {string[]} at most `MAX_IMAGES` URLs, in the order the post listed them.
 */
export function selectImageUrls(result) {
  try {
    const posts = result?.posts;
    if (!Array.isArray(posts) || posts.length === 0) return [];
    // Scan EVERY post to find the newest one that carries pictures; attach at most that one.
    // Stopping at the first post with images would be simpler but wrong: the response order is
    // not this layer's contract, and an older post appearing first would then win.
    let chosen = null;
    for (const post of posts) {
      if (!isPlainRecord(post)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(post, 'images');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const images = descriptor.value;
      if (!Array.isArray(images) || images.length === 0) continue;
      const time = Object.getOwnPropertyDescriptor(post, 'time')?.value;
      const rank = Number.isFinite(time) ? time : 0;
      if (chosen === null || rank > chosen.rank) chosen = { rank, images };
    }
    if (chosen === null) return [];
    const urls = [];
    for (const url of chosen.images) {
      if (urls.length >= MAX_IMAGES) break;
      if (isFetchableImageUrl(url)) urls.push(url);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Build the loader `native-tool.mjs` calls after a successful `read_posts`.
 *
 * @param {object} options
 * @param {{saveImage: Function}} options.attachments  the host's attachment service.
 * @param {(url: string, options: {signal: AbortSignal}) => Promise<Uint8Array|null>} options.downloadImage
 *   injected downloader (no default: tests pass a fake, the caller passes `safeFetchBuffer`). It
 *   MUST be the platform's SSRF-guarded fetcher, not a bare `fetch`: the URLs come from post
 *   content written by another account, so a raw fetch would let that account point this process
 *   at 127.0.0.1, 169.254.169.254 or a LAN address and read the response back through the model.
 * @param {() => number} [options.now]
 * @returns {(result: object, exec: object) => Promise<object[]>} resolves to attachment references;
 *   an EMPTY array means "no pictures this time", never an error.
 * @throws {TypeError} at construction when a dependency is unusable — a misconfigured loader must
 *   fail while the plugin is loading, not silently on every read.
 */
export function createQzoneImageLoader({ attachments, downloadImage, now = Date.now } = {}) {
  if (attachments === null || typeof attachments !== 'object' || typeof attachments.saveImage !== 'function') {
    throw new TypeError('image loader needs an attachments service with saveImage');
  }
  if (typeof downloadImage !== 'function') throw new TypeError('image loader needs an injected downloadImage function');
  if (typeof now !== 'function') throw new TypeError('image loader needs a clock');

  /** Download ONE url into an attachment reference, or `null` for any failure. Never throws. */
  async function loadOne(url, index, budgetMs = DOWNLOAD_TIMEOUT_MS) {
    const controller = new AbortController();
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch { /* already aborted */ }
          resolve(null);
        }, Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MS, budgetMs)));
      });
      const work = (async () => {
        // The downloader is the host's guarded fetcher. It enforces the address policy (no
        // loopback, no link-local, no LAN) and the byte cap itself, and it refuses redirects —
        // which is what makes it safe to hand it a URL written by another QQ account.
        const bytes = await downloadImage(url, { signal: controller.signal, maxBytes: MAX_IMAGE_BYTES });
        if (!(bytes instanceof Uint8Array) || bytes.length < SNIFF_BYTES) return null;
        const mediaType = sniffImageMediaType(bytes);
        // Unrecognised bytes are skipped rather than stored: an attachment whose declared type
        // disagrees with its content is worse than no attachment.
        if (mediaType === null) return null;
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType,
          name: 'qzone-post-image-' + (index + 1),
        });
        return isPlainRecord(ref) && typeof ref.attachmentId === 'string' ? ref : null;
      })();
      // Observe a late rejection so an aborted download cannot surface as unhandled afterwards.
      work.catch(() => {});
      return await Promise.race([work, deadline]);
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }

  return async function loadPostImages(result) {
    const urls = selectImageUrls(result);
    if (urls.length === 0) return [];
    const refs = [];
    const deadlineAt = now() + TOTAL_DOWNLOAD_BUDGET_MS;
    for (let index = 0; index < urls.length; index += 1) {
      // Sequential on purpose: three parallel 8 MiB downloads are three times the exposure for a
      // feature whose whole point is "a couple of pictures alongside the text".
      //
      // And the SEQUENCE gets one shared deadline: once the total budget is gone, the remaining
      // pictures are simply not fetched. A picture is an enhancement to an answer that has already
      // been produced — it must never be worth making the caller wait for.
      if (now() >= deadlineAt) break;
      const ref = await loadOne(urls[index], index, deadlineAt - now());
      if (ref !== null) refs.push(ref);
    }
    return refs;
  };
}

export { MAX_IMAGES as _MAX_IMAGES, MAX_IMAGE_BYTES as _MAX_IMAGE_BYTES };