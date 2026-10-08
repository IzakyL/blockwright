import { deflateSync, inflateSync } from "node:zlib";

/** Raw pixels: `width * height * 4` bytes of top-down RGBA. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) crc = CRC_TABLE[(crc ^ part[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * Encodes top-down RGBA as an 8-bit RGBA PNG. Rows use the Up filter (rendered frames compress well
 * with it); `level` is the zlib level (default 6).
 */
export function encodePng(image: RgbaImage, level = 6): Buffer {
  const { width, height, rgba } = image;
  const stride = width * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (rgba.length !== stride * height) {
    throw new RangeError(`expected ${stride * height} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
  }
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    const row = y * stride;
    if (y === 0) {
      filtered[out] = 0;
      rgba.copy(filtered, out + 1, row, row + stride);
      continue;
    }
    filtered[out] = 2;
    const up = row - stride;
    for (let x = 0; x < stride; x++) filtered[out + 1 + x] = (rgba[row + x]! - rgba[up + x]!) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filtered, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what {@link encodePng} and most tools write) to
 * top-down RGBA. Other PNG flavours throw.
 */
export function decodePng(png: Buffer): RgbaImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 6 && color !== 2) || data[12] !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${color}, interlace ${data[12]})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!channels) throw new Error("PNG without IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!;
      const left = x >= channels ? lines[out + x - channels]! : 0;
      const up = y > 0 ? lines[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? lines[out - stride + x - channels]! : 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      lines[out + x] = (value + predicted) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: lines };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < lines.length; i += 3, j += 4) {
    rgba[j] = lines[i]!;
    rgba[j + 1] = lines[i + 1]!;
    rgba[j + 2] = lines[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** How varied an image is: the number of distinct colours among up to `samples` evenly spaced pixels. */
export function distinctColors(image: RgbaImage, samples = 4096): number {
  const pixels = image.width * image.height;
  const step = Math.max(1, Math.floor(pixels / samples));
  const seen = new Set<number>();
  for (let i = 0; i < pixels; i += step) seen.add(image.rgba.readUInt32LE(i * 4));
  return seen.size;
}
