// Zero-dependency placeholder PWA icon generator.
// Produces solid-color square PNGs with a centered circle ("golf ball on green")
// using only Node's built-in zlib for PNG deflate compression.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePng(size, { bg, fg, maskable }) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = maskable ? width * 0.32 : width * 0.36;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inCircle = Math.sqrt(dx * dx + dy * dy) <= radius;
      const color = inCircle ? fg : bg;
      const idx = rowStart + 1 + x * 4;
      raw[idx] = color[0];
      raw[idx + 1] = color[1];
      raw[idx + 2] = color[2];
      raw[idx + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const BRAND = [27, 94, 60]; // #1b5e3c
const WHITE = [255, 255, 255];

fs.writeFileSync(
  path.join(outDir, 'icon-192.png'),
  makePng(192, { bg: BRAND, fg: WHITE, maskable: false }),
);
fs.writeFileSync(
  path.join(outDir, 'icon-512.png'),
  makePng(512, { bg: BRAND, fg: WHITE, maskable: false }),
);
fs.writeFileSync(
  path.join(outDir, 'icon-maskable-512.png'),
  makePng(512, { bg: BRAND, fg: WHITE, maskable: true }),
);

console.log('Generated placeholder icons in', outDir);
