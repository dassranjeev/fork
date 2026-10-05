/**
 * Dependency-free metadata stripper for proof photos (privacy: a phone photo carries the driver's GPS, device model, serial numbers).
 * JPEG: drops APP1 (Exif / XMP), APP2 (ICC / FlashPix), APP12-APP15 (Ducky / Photoshop IRB / Adobe), COM. Keeps APP0 (JFIF), APP14 (Adobe colour transform) is dropped only if it is not needed - kept for safety.
 * PNG: drops eXIf, tEXt, zTXt, iTXt, tIME, iCCP chunks. Returns null when the buffer is not a well-formed JPEG / PNG (caller rejects the photo).
 */
export function stripImageMetadata(buf: Buffer): { buf: Buffer; mime: 'image/jpeg' | 'image/png' } | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const out = stripJpeg(buf);
    return out ? { buf: out, mime: 'image/jpeg' } : null;
  }
  if (buf.length > 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const out = stripPng(buf);
    return out ? { buf: out, mime: 'image/png' } : null;
  }
  return null;
}

function stripJpeg(b: Buffer): Buffer | null {
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff) { i++; m = b[i + 1]; }
    if (m === 0xd9) { parts.push(b.subarray(i, i + 2)); return Buffer.concat(parts); }
    if (m === 0xda) { parts.push(b.subarray(i)); return Buffer.concat(parts); } // start of scan: the rest is entropy-coded data
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = m === 0xe1 || m === 0xe2 || m === 0xed || m === 0xfe || m === 0xef || m === 0xec;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'iCCP']);
function stripPng(b: Buffer): Buffer | null {
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  let sawEnd = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  return sawEnd ? Buffer.concat(parts) : null;
}
