'use strict';

/*
 * Generates placeholder PNG artwork (app + driver images) so the app passes
 * Homey validation before final artwork is produced. Re-run with:
 *   node scripts/gen-assets.js
 * Replace the output with real artwork before publishing to the App Store.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Brand + accent colours.
const BG = [15, 20, 32]; // #0f1420
const ACCENT = [35, 211, 176]; // #23d3b0

function makePNG(width, height) {
  const cx = width / 2;
  const cy = height * 0.46;
  const r = Math.min(width, height) * 0.3;
  const r2 = r * 0.32;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      const d = Math.hypot(x - cx, y - cy);
      let col = BG;
      if (d <= r) col = ACCENT;
      if (d <= r2) col = BG; // sensor dome
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(file, width, height) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makePNG(width, height));
  console.log(`wrote ${file} (${width}x${height})`);
}

const root = path.join(__dirname, '..');

// App images.
write(path.join(root, 'assets/images/small.png'), 250, 175);
write(path.join(root, 'assets/images/large.png'), 500, 350);
write(path.join(root, 'assets/images/xlarge.png'), 1000, 700);

// Driver images.
write(path.join(root, 'drivers/narwal_vacuum/assets/images/small.png'), 75, 75);
write(path.join(root, 'drivers/narwal_vacuum/assets/images/large.png'), 500, 500);
write(path.join(root, 'drivers/narwal_vacuum/assets/images/xlarge.png'), 1000, 1000);

console.log('done');
