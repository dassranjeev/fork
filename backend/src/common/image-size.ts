/** Width and height of a PNG, JPEG, GIF or WebP picture read from its header (no image library needed). null = not a picture this can read. */
export function imageSize(buf: Buffer): { width: number; height: number; type: 'png' | 'jpg' | 'gif' | 'webp' } | null {
  if (buf.length < 24) return null;
  // PNG: signature, then the IHDR chunk holds width and height
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'gif' };
  // JPEG: walk the segments to the first start-of-frame marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      let m = buf[i + 1];
      while (m === 0xff && i + 2 < buf.length) {
        i++;
        m = buf[i + 1];
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'jpg' };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 (lossy), VP8L (lossless) or VP8X (extended)
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (kind === 'VP8X' && buf.length >= 30) return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)), type: 'webp' };
  }
  return null;
}
