import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'apps/miniapp/public/assets');
fs.mkdirSync(target, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, checksum]);
}
function png(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = color[3] ?? 255;
  };
  const rectangle = (x, y, w, h, color, radius = 0) => {
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px += 1) {
        const cx = px < x + radius ? x + radius : px >= x + w - radius ? x + w - radius - 1 : px;
        const cy = py < y + radius ? y + radius : py >= y + h - radius ? y + h - radius - 1 : py;
        if (radius && (px !== cx || py !== cy) && (px - cx) ** 2 + (py - cy) ** 2 > radius ** 2) continue;
        set(px, py, color);
      }
    }
  };
  const circle = (cx, cy, radius, color) => {
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) set(x, y, color);
      }
    }
  };
  const triangle = (x1, y1, x2, y2, x3, y3, color) => {
    const minX = Math.floor(Math.min(x1, x2, x3)), maxX = Math.ceil(Math.max(x1, x2, x3));
    const minY = Math.floor(Math.min(y1, y2, y3)), maxY = Math.ceil(Math.max(y1, y2, y3));
    const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const d1 = sign(x, y, x1, y1, x2, y2), d2 = sign(x, y, x2, y2, x3, y3), d3 = sign(x, y, x3, y3, x1, y1);
      if ((d1 < 0 && d2 < 0 && d3 < 0) || (d1 >= 0 && d2 >= 0 && d3 >= 0)) set(x, y, color);
    }
  };
  paint({ set, rectangle, circle, triangle, width, height });
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 4 + 1)] = 0;
    pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function write(name, painter) { fs.writeFileSync(path.join(target, name), png(800, 500, painter)); }

write('stream-pass.png', ({ rectangle, circle, triangle }) => {
  rectangle(0, 0, 800, 500, [15, 48, 45, 255]);
  rectangle(40, 40, 720, 420, [29, 85, 78, 255], 28);
  for (let index = 0; index < 8; index += 1) circle(670 + (index % 2) * 42, 95 + Math.floor(index / 2) * 48, 12, [79, 177, 165, 255]);
  rectangle(135, 120, 360, 250, [242, 194, 72, 255], 22);
  rectangle(165, 150, 300, 190, [245, 229, 170, 255], 14);
  circle(315, 245, 64, [15, 48, 45, 255]);
  triangle(300, 208, 300, 282, 365, 245, [242, 194, 72, 255]);
  rectangle(120, 392, 260, 16, [79, 177, 165, 255], 8);
});
write('game-points.png', ({ rectangle, circle }) => {
  rectangle(0, 0, 800, 500, [30, 44, 77, 255]);
  rectangle(40, 40, 720, 420, [48, 71, 119, 255], 28);
  for (let index = 0; index < 10; index += 1) circle(120 + index * 62, 120 + (index % 3) * 92, 22, [94, 191, 194, 255]);
  rectangle(300, 110, 300, 290, [231, 94, 67, 255], 28);
  rectangle(330, 145, 240, 220, [245, 130, 95, 255], 18);
  circle(410, 255, 62, [250, 209, 78, 255]);
  circle(410, 255, 40, [231, 94, 67, 255]);
  circle(520, 205, 34, [250, 209, 78, 255]);
  circle(520, 310, 34, [250, 209, 78, 255]);
});
write('gift-vault.png', ({ rectangle, circle }) => {
  rectangle(0, 0, 800, 500, [77, 30, 62, 255]);
  rectangle(40, 40, 720, 420, [127, 47, 88, 255], 28);
  for (let index = 0; index < 7; index += 1) circle(100 + index * 95, 105 + (index % 2) * 250, 15, [241, 190, 71, 255]);
  rectangle(235, 155, 330, 220, [28, 50, 69, 255], 26);
  rectangle(265, 185, 270, 160, [43, 74, 96, 255], 15);
  rectangle(360, 215, 80, 95, [241, 190, 71, 255], 18);
  circle(400, 260, 16, [28, 50, 69, 255]);
  rectangle(310, 120, 180, 45, [241, 190, 71, 255], 18);
});
console.log(`Generated assets in ${target}`);
