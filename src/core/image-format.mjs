// Pure image-format seam extracted verbatim from src/bridge.js at faaa226 (2026-10-20),
// lines 8979-9061: mimeFromBuffer -> detectImageMime, mimeFromUrl -> imageMimeFromUrl,
// getImageDimensions -> imageDimensions, base64FromMaybe -> parseImageBase64.
//
// The four bodies are mechanical copies with only their exported names changed. Legacy quirks are
// intentional and must not be "improved": the 12-byte mime guard and 24-byte dimension guard, the
// default 'image/jpeg' fallback, the JPEG marker walk (SOF0-SOF15 minus C4/C8/CC, standalone and
// restart skips, len<2 abort, truncated segments silently ending), the WebP VP8X/VP8L/VP8 bit
// arithmetic, URL fallback swallowing coercion errors, and the permissive base64 stripping.
// Only built-ins (Buffer, URL, RegExp, String, Number, Array) are used; no external I/O or state.
export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

export function imageMimeFromUrl(url, fallback = 'image/jpeg') {
  try {
    const pathname = new URL(String(url)).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  } catch {}
  return fallback;
}

export function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) return null;
        // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
    }
  } catch {}
  return null;
}

export function parseImageBase64(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
  if (s.startsWith('data:image/')) {
    const idx = s.indexOf(',');
    if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
  }
  // 纯 base64（允许少量空白）
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
  return null;
}
