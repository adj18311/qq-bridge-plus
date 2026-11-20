// 独立安装包内的安全图像适配器：绝不转发 cookie，默认不跟随重定向。
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.mjs';

const HOSTS = new Set(['imgheybox.max-c.com', 'imgheybox1.max-c.com', 'cdn.max-c.com']);
const MAX_IMAGES = 10;
const MAX_BYTES = 4 * 1024 * 1024;
// 总量上限 8 MiB 是离线保守取舍（2026-11-01 指令）：25 MiB 原图经 base64 约 33 MiB 进工具结果，
// 可能触发宿主结果截断或上下文压力；8 MiB -> base64 约 10.67 MiB。这**不是**已证实的宿主上限。
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 20_000;

// 时长格式化：单位必须明确（秒/毫秒），不能拿字节格式化代替。
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知时长';
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }
  return `${Math.round(ms)} 毫秒`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function imageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch { return null; }
}

function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || !looksLikeImageBuffer(buffer)) return null;
  // 结构检查用于拒绝常见截断和伪文件头，不声称等同于完整解码。
  if (buffer[0] === 0x89) {
    if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return null;
    let p = 8, header = false, data = false;
    while (p + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(p), end = p + 12 + size;
      if (end > buffer.length) return null;
      const type = buffer.toString('ascii', p + 4, p + 8);
      if (!header) {
        if (type !== 'IHDR' || size !== 13) return null;
        const w = buffer.readUInt32BE(p + 8), h = buffer.readUInt32BE(p + 12);
        if (!w || !h || w > 8192 || h > 8192 || w * h > 64_000_000) return null;
        header = true;
      }
      if (type === 'IDAT' && size > 0) data = true;
      if (type === 'IEND') return size === 0 && data && end === buffer.length ? 'image/png' : null;
      p = end;
    }
    return null;
  }
  if (buffer[0] === 0xff) {
    if (buffer.length < 16 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
    // JPEG 至少需要帧头和扫描头；其他编码细节交由模型端解码器检查。
    let frame = false, scan = false;
    for (let p = 2; p + 3 < buffer.length;) {
      if (buffer[p] !== 0xff) return null;
      while (buffer[p] === 0xff) p++;
      const marker = buffer[p++];
      if (marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > buffer.length) return null;
      const size = buffer.readUInt16BE(p);
      if (size < 2 || p + size > buffer.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) return null;
        const h = buffer.readUInt16BE(p + 3), w = buffer.readUInt16BE(p + 5);
        if (!w || !h || w > 8192 || h > 8192 || w * h > 64_000_000) return null;
        frame = true;
      }
      if (marker === 0xda) { scan = true; break; }
      p += size;
    }
    return frame && scan ? 'image/jpeg' : null;
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    if (buffer.length < 20 || buffer[buffer.length - 1] !== 0x3b) return null;
    const w = buffer.readUInt16LE(6), h = buffer.readUInt16LE(8);
    return w && h && w <= 8192 && h <= 8192 && w * h <= 64_000_000 && buffer.includes(0x2c, 13) ? 'image/gif' : null;
  }
  if (buffer.length < 24 || buffer.readUInt32LE(4) + 8 !== buffer.length) return null;
  let position = 12, hasFrame = false;
  while (position + 8 <= buffer.length) {
    const kind = buffer.toString('ascii', position, position + 4);
    const size = buffer.readUInt32LE(position + 4), start = position + 8, end = start + size + (size % 2);
    if (end > buffer.length) return null;
    if (kind === 'VP8X') {
      if (size !== 10) return null;
      const w = buffer.readUIntLE(start + 4, 3) + 1, h = buffer.readUIntLE(start + 7, 3) + 1;
      if (w > 8192 || h > 8192 || w * h > 64_000_000) return null;
    }
    if (kind === 'VP8 ' && size >= 10 && buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
      const w = buffer.readUInt16LE(start + 6) & 0x3fff, h = buffer.readUInt16LE(start + 8) & 0x3fff;
      if (!w || !h || w > 8192 || h > 8192 || w * h > 64_000_000) return null;
      hasFrame = true;
    }
    if (kind === 'VP8L' && size >= 5 && buffer[start] === 0x2f) {
      const bits = buffer.readUInt32LE(start + 1), w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1;
      if (w > 8192 || h > 8192 || w * h > 64_000_000) return null;
      hasFrame = true;
    }
    if (kind === 'ANMF' && size > 16) hasFrame = true;
    position = end;
  }
  return hasFrame && position === buffer.length ? 'image/webp' : null;
}

function bound(value, hard) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : hard;
}

/**
 * 只负责**下载与校验**：返回原始字节与媒体类型，不产生任何“已提供/已附上”的措辞。
 *
 * 为什么拆开：附件能否真正落盘取决于宿主（attachments 服务 + 模型视觉能力），
 * 下载成功 ≠ 模型看得到。把两者混在一起会在失败时给出“已提供图像内容”的假承诺。
 *
 * @returns {Promise<{images: Array<{url:string, buffer:Buffer, mimeType:string}>, notes: string[]}>}
 */
export async function downloadXhhImages(urls, options = {}) {
  const maxImages = bound(options.maxImages, MAX_IMAGES);
  const maxBytes = bound(options.maxBytes, MAX_BYTES);
  const maxTotalBytes = bound(options.maxTotalBytes, MAX_TOTAL_BYTES);
  const fetchBuffer = typeof options.fetchBuffer === 'function' ? options.fetchBuffer : safeFetchBuffer;
  const deadline = Date.now() + bound(options.maxDurationMs, MAX_DURATION_MS);
  const externalSignal = options.signal instanceof AbortSignal ? options.signal : null;
  const list = Array.isArray(urls) ? urls.slice(0, 100) : [];
  const images = [], notes = [], seen = new Set();
  let total = 0, eligible = 0;
  for (let i = 0; i < list.length; i++) {
    if (externalSignal?.aborted) { notes.push('（图片获取已取消，剩余图片未取）'); break; }
    const url = imageUrl(list[i]);
    if (!url) { notes.push(`[图片${i + 1}：地址不在安全白名单，未取]`); continue; }
    if (seen.has(url)) { notes.push(`[图片${i + 1}：重复地址，未重复获取]`); continue; }
    seen.add(url);
    if (eligible++ >= maxImages) { notes.push(`[图片${i + 1}：超过数量上限，未取]`); continue; }
    const remaining = maxTotalBytes - total;
    if (remaining <= 0) { notes.push(`[图片${i + 1}：剩余总预算不足（已用 ${formatBytes(total)}），未取]`); continue; }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) { notes.push('（图片获取超时，剩余图片未取）'); break; }
    let timer, timedOut = false;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    let onAbort;
    try {
      const result = await Promise.race([
        fetchBuffer(url, Math.min(maxBytes, remaining), { signal: controller.signal, allowRedirect: false, headers: { referer: 'https://www.xiaoheihe.cn/' } }),
        new Promise((_, reject) => {
          onAbort = () => reject(new Error('image-aborted'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
          timer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs);
        }),
      ]);
      const buffer = result?.buffer;
      const mimeType = imageMime(buffer);
      if (!mimeType) throw new Error('invalid-image');
      if (buffer.length > maxBytes) throw new Error('oversize-single');
      if (buffer.length > remaining) throw new Error('oversize-total');
      total += buffer.length;
      images.push({ url, buffer, mimeType });
    } catch (error) {
      const code = String(error?.message ?? '');
      if (code === 'oversize-single') notes.push(`[图片${i + 1}：超过单张上限（${formatBytes(maxBytes)}），未取]`);
      else if (code === 'oversize-total') notes.push(`[图片${i + 1}：剩余总预算不足（剩余 ${formatBytes(remaining)}），未取]`);
      else if (code === 'image-aborted') notes.push(timedOut
        ? `[图片${i + 1}：获取超时（本次剩余 ${formatDuration(remainingMs)} 预算），未取]`
        : `[图片${i + 1}：获取已取消，未取]`);
      else if (/图片超过大小限制/u.test(code)) {
        notes.push(remaining < maxBytes
          ? `[图片${i + 1}：剩余总预算不足（剩余 ${formatBytes(remaining)}），未取]`
          : `[图片${i + 1}：超过单张上限（${formatBytes(maxBytes)}），未取]`);
      } else notes.push(`[图片${i + 1}：获取失败或不符合图片限制，未取]`);
    }
    finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
  if (Array.isArray(urls) && urls.length > list.length) notes.push(`（另有 ${urls.length - list.length} 个地址因输入上限未处理）`);
  return { images, notes };
}

/**
 * 兼容包装：下载并直接产出「裸图片块 + 已提供措辞」。
 *
 * @deprecated 仅保留给既有单元测试与历史调用；新代码必须用 downloadXhhImages +
 * 宿主附件准入（见 image-admission.mjs），不得据此声称图片已呈现给模型。
 */
export async function buildXhhImageContent(urls, options = {}) {
  const { images, notes } = await downloadXhhImages(urls, options);
  const content = images.map((image) => ({
    type: 'image',
    mimeType: image.mimeType,
    data: image.buffer.toString('base64'),
  }));
  const provision = images.map((image, index) => `[图片${index + 1}：已提供图像内容，可用 qq_send_image 发送：${image.url}]`);
  return { content, notes: [...notes, ...provision], images };
}
