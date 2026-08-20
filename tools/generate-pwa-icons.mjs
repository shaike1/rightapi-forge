// Generates the Beacon PWA icons (public/icons/icon-{192,512}.png).
//
// Pure stdlib — no external image library. PNG layout:
//   signature + IHDR + IDAT (deflated raw scanlines) + IEND
// Each chunk carries its own CRC32 (custom table, polynomial 0xEDB88320).
//
// Visual: solid #306EF0 square (the Beacon accent token) with a
// chunky white "B" centered on it. The "B" is drawn from a 7×7
// pixel-font glyph that's scaled up by an integer factor so the
// letter looks crisp at both 192 and 512.
//
// Run: `node tools/generate-pwa-icons.mjs`. Idempotent — re-running just
// re-emits the same bytes. CI doesn't run this; the PNGs are checked in.

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── CRC32 ────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk helpers ────────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 7×7 pixel-font "B" — 1 = white pixel.
const GLYPH_B = [
  '11110..',
  '1...1..',
  '1...1..',
  '11110..',
  '1...1..',
  '1...1..',
  '11110..',
];

function makePng(size, bg, fg) {
  const width = size;
  const height = size;

  // Pre-compute the "B" pixels for this output size. Glyph is 7 wide ×
  // 7 tall; scale to ~60% of the icon size; round to an integer cell.
  const cellSize = Math.floor((size * 0.6) / 7);
  const glyphW = cellSize * 7;
  const glyphH = cellSize * 7;
  const offX = Math.floor((width  - glyphW) / 2);
  const offY = Math.floor((height - glyphH) / 2);

  // Build raw pixels (3 bytes per pixel, row prefixed by filter byte 0).
  const rowLen = width * 3 + 1;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < width; x++) {
      let color = bg;
      const gx = x - offX;
      const gy = y - offY;
      if (gx >= 0 && gx < glyphW && gy >= 0 && gy < glyphH) {
        const col = Math.floor(gx / cellSize);
        const row = Math.floor(gy / cellSize);
        if (GLYPH_B[row][col] === '1') color = fg;
      }
      const off = y * rowLen + 1 + x * 3;
      raw[off]     = color[0];
      raw[off + 1] = color[1];
      raw[off + 2] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 2;   // color type: truecolor RGB
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// #306EF0 background, white "B"
const BG = [0x30, 0x6E, 0xF0];
const FG = [0xFF, 0xFF, 0xFF];

const outDir = join(ROOT, 'public', 'icons');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const buf = makePng(size, BG, FG);
  const out = join(outDir, `icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes, ${size}×${size})`);
}
