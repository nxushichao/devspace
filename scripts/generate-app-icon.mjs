import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = resolve(repositoryRoot, "build", "icon.ico");
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(Math.max(value, minimum), maximum);
}

function blendPixel(pixels, size, x, y, color, opacity = 1) {
  if (x < 0 || x >= size || y < 0 || y >= size || opacity <= 0) return;

  const offset = (y * size + x) * 4;
  const sourceAlpha = clamp((color[3] ?? 255) / 255 * opacity);
  const targetAlpha = pixels[offset + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;

  for (let channel = 0; channel < 3; channel += 1) {
    const source = color[channel] / 255;
    const target = pixels[offset + channel] / 255;
    pixels[offset + channel] = Math.round(((source * sourceAlpha) + (target * targetAlpha * (1 - sourceAlpha))) / outputAlpha * 255);
  }
  pixels[offset + 3] = Math.round(outputAlpha * 255);
}

function drawCircle(pixels, size, centerX, centerY, radius, color) {
  const left = Math.floor((centerX - radius) * size - 1);
  const right = Math.ceil((centerX + radius) * size + 1);
  const top = Math.floor((centerY - radius) * size - 1);
  const bottom = Math.ceil((centerY + radius) * size + 1);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const normalizedX = (x + 0.5) / size;
      const normalizedY = (y + 0.5) / size;
      const distance = Math.hypot(normalizedX - centerX, normalizedY - centerY);
      const coverage = clamp((radius - distance) * size + 0.5);
      blendPixel(pixels, size, x, y, color, coverage);
    }
  }
}

function drawSegment(pixels, size, startX, startY, endX, endY, radius, color) {
  const left = Math.floor((Math.min(startX, endX) - radius) * size - 1);
  const right = Math.ceil((Math.max(startX, endX) + radius) * size + 1);
  const top = Math.floor((Math.min(startY, endY) - radius) * size - 1);
  const bottom = Math.ceil((Math.max(startY, endY) + radius) * size + 1);
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const normalizedX = (x + 0.5) / size;
      const normalizedY = (y + 0.5) / size;
      const projection = clamp(((normalizedX - startX) * deltaX + (normalizedY - startY) * deltaY) / lengthSquared);
      const closestX = startX + projection * deltaX;
      const closestY = startY + projection * deltaY;
      const distance = Math.hypot(normalizedX - closestX, normalizedY - closestY);
      const coverage = clamp((radius - distance) * size + 0.5);
      blendPixel(pixels, size, x, y, color, coverage);
    }
  }
}

function drawBackground(pixels, size) {
  const margin = 0.065;
  const radius = 0.205;
  const edge = 0.5 - margin - radius;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const horizontal = Math.max(Math.abs((x + 0.5) / size - 0.5) - edge, 0);
      const vertical = Math.max(Math.abs((y + 0.5) / size - 0.5) - edge, 0);
      const signedDistance = Math.hypot(horizontal, vertical) - radius;
      const coverage = clamp(0.5 - signedDistance * size);
      if (coverage <= 0) continue;

      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const highlight = clamp(1 - Math.hypot(u - 0.25, v - 0.18) / 0.95);
      const depth = clamp((u * 0.25) + (v * 0.45));
      const color = [
        Math.round(16 + highlight * 21 + depth * 4),
        Math.round(37 + highlight * 35 + depth * 13),
        Math.round(78 + highlight * 70 + depth * 46),
        255,
      ];
      blendPixel(pixels, size, x, y, color, coverage);
    }
  }
}

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  drawBackground(pixels, size);

  // 核心图形以“工作空间 + 连接节点”为意象，确保小尺寸下依然清晰可辨。
  const mint = [101, 232, 194, 255];
  const blue = [118, 160, 255, 255];
  const bright = [221, 248, 255, 255];
  const shadow = [6, 16, 42, 150];

  drawSegment(pixels, size, 0.315, 0.25, 0.57, 0.25, 0.053, shadow);
  drawSegment(pixels, size, 0.315, 0.25, 0.315, 0.75, 0.053, shadow);
  drawSegment(pixels, size, 0.315, 0.75, 0.57, 0.75, 0.053, shadow);
  drawSegment(pixels, size, 0.57, 0.25, 0.72, 0.40, 0.053, shadow);
  drawSegment(pixels, size, 0.72, 0.40, 0.72, 0.60, 0.053, shadow);
  drawSegment(pixels, size, 0.72, 0.60, 0.57, 0.75, 0.053, shadow);

  drawSegment(pixels, size, 0.305, 0.235, 0.565, 0.235, 0.043, mint);
  drawSegment(pixels, size, 0.305, 0.235, 0.305, 0.765, 0.043, mint);
  drawSegment(pixels, size, 0.305, 0.765, 0.565, 0.765, 0.043, mint);
  drawSegment(pixels, size, 0.565, 0.235, 0.735, 0.405, 0.043, blue);
  drawSegment(pixels, size, 0.735, 0.405, 0.735, 0.595, 0.043, blue);
  drawSegment(pixels, size, 0.735, 0.595, 0.565, 0.765, 0.043, blue);

  drawCircle(pixels, size, 0.305, 0.235, 0.062, mint);
  drawCircle(pixels, size, 0.305, 0.765, 0.062, mint);
  drawCircle(pixels, size, 0.735, 0.405, 0.062, blue);
  drawCircle(pixels, size, 0.735, 0.595, 0.062, blue);
  drawCircle(pixels, size, 0.545, 0.50, 0.048, bright);
  drawCircle(pixels, size, 0.545, 0.50, 0.020, [15, 41, 89, 255]);

  return pixels;
}

function encodeBmpIcon(size, rgbaPixels) {
  const xorRowBytes = size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const bitmapData = Buffer.alloc(40 + xorRowBytes * size + andRowBytes * size);

  bitmapData.writeUInt32LE(40, 0);
  bitmapData.writeInt32LE(size, 4);
  bitmapData.writeInt32LE(size * 2, 8);
  bitmapData.writeUInt16LE(1, 12);
  bitmapData.writeUInt16LE(32, 14);
  bitmapData.writeUInt32LE(0, 16);
  bitmapData.writeUInt32LE(xorRowBytes * size, 20);
  bitmapData.writeInt32LE(0, 24);
  bitmapData.writeInt32LE(0, 28);
  bitmapData.writeUInt32LE(0, 32);
  bitmapData.writeUInt32LE(0, 36);

  const pixelsOffset = 40;
  for (let y = 0; y < size; y += 1) {
    const sourceY = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (sourceY * size + x) * 4;
      const destinationOffset = pixelsOffset + (y * size + x) * 4;
      bitmapData[destinationOffset] = rgbaPixels[sourceOffset + 2];
      bitmapData[destinationOffset + 1] = rgbaPixels[sourceOffset + 1];
      bitmapData[destinationOffset + 2] = rgbaPixels[sourceOffset];
      bitmapData[destinationOffset + 3] = rgbaPixels[sourceOffset + 3];
    }
  }

  return bitmapData;
}

function createIco() {
  const images = ICON_SIZES.map((size) => encodeBmpIcon(size, renderIcon(size)));
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = directorySize;
  images.forEach((image, index) => {
    const entryOffset = 6 + index * 16;
    const size = ICON_SIZES[index];
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += image.length;
  });

  return Buffer.concat([header, ...images]);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, createIco());
console.log(`Generated application icon: ${outputPath}`);
