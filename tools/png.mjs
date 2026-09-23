// Zero-dependency PNG read/write for the sprite tools. Node's zlib does the
// compression; everything else here is the PNG container itself.
// Supports 8-bit colour types 0/2/3/4/6, no interlace - covers every sprite in
// this workspace. Always decodes to flat RGBA8 and always writes RGBA8.
import zlib from "node:zlib";
import fs from "node:fs";

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error("only 8-bit PNGs are supported (got depth " + depth + ")");
  if (interlace) throw new Error("interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error("unsupported colour type " + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const lines = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 255;
      else if (filter === 2) cur[i] = (cur[i] + b) & 255;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 255;
    }
  }
  // Flatten to RGBA8.
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * bpp, d = i * 4;
    if (ctype === 6) { px[d] = lines[s]; px[d + 1] = lines[s + 1]; px[d + 2] = lines[s + 2]; px[d + 3] = lines[s + 3]; }
    else if (ctype === 2) { px[d] = lines[s]; px[d + 1] = lines[s + 1]; px[d + 2] = lines[s + 2]; px[d + 3] = 255; }
    else if (ctype === 0) { px[d] = px[d + 1] = px[d + 2] = lines[s]; px[d + 3] = 255; }
    else if (ctype === 4) { px[d] = px[d + 1] = px[d + 2] = lines[s]; px[d + 3] = lines[s + 1]; }
    else if (ctype === 3) {
      const idx = lines[s];
      px[d] = palette[idx * 3]; px[d + 1] = palette[idx * 3 + 1]; px[d + 2] = palette[idx * 3 + 2];
      px[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width: w, height: h, data: px };
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const readPng = (p) => decodePng(fs.readFileSync(p));
export const writePng = (p, img) => fs.writeFileSync(p, encodePng(img));
