/**
 * Minimal PNG read/write plus the compositing the icon script needs. Node's
 * zlib is enough for both directions, which matters because this machine has no
 * rasterizer — no PIL, no rsvg, no ImageMagick.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encodes 8-bit RGBA. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Decodes a non-interlaced 8-bit RGB/RGBA PNG to RGBA. */
export function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const parts = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error('only 8-bit PNGs are supported')
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported')
    }
    if (type === 'IDAT') parts.push(data)
    offset += 12 + length
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  if (channels === 1) throw new Error('palette and greyscale PNGs are not supported')

  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const planar = Buffer.alloc(height * stride)

  // Undo the per-scanline filters.
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? planar[y * stride + i - channels] : 0
      const up = y > 0 ? planar[(y - 1) * stride + i] : 0
      const upLeft = i >= channels && y > 0 ? planar[(y - 1) * stride + i - channels] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft)
        const pb = Math.abs(left - upLeft)
        const pc = Math.abs(left + up - 2 * upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      planar[y * stride + i] = value & 0xff
    }
  }

  if (channels === 4) return { width, height, rgba: planar }

  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < planar.length; i += 3, j += 4) {
    rgba[j] = planar[i]
    rgba[j + 1] = planar[i + 1]
    rgba[j + 2] = planar[i + 2]
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}

/** True inside a full-bleed squircle-ish rounded rectangle. */
export function inRoundedRect(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false
  const cx = Math.min(Math.max(x, radius), 1 - radius)
  const cy = Math.min(Math.max(y, radius), 1 - radius)
  if (x >= radius && x <= 1 - radius) return true
  if (y >= radius && y <= 1 - radius) return true
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/**
 * Fills the transparent area inside a rounded rectangle with `plate`, so a
 * circular mark reads as a full-bleed macOS icon instead of floating in the
 * dock. Supersampled so the plate's corners stay smooth.
 */
export function onPlate(image, plate, radius = 0.225, samples = 4) {
  const { width, height, rgba } = image
  const out = Buffer.from(rgba)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (out[i + 3] === 255) continue

      let inside = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const fx = (x + (sx + 0.5) / samples) / width
          const fy = (y + (sy + 0.5) / samples) / height
          if (inRoundedRect(fx, fy, radius)) inside++
        }
      }
      if (inside === 0) continue

      // Composite whatever the mark already has over the plate.
      const coverage = inside / (samples * samples)
      const alpha = out[i + 3] / 255
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round(out[i + c] * alpha + plate[c] * (1 - alpha))
      }
      out[i + 3] = Math.round(Math.max(alpha, coverage) * 255)
    }
  }

  return { width, height, rgba: out }
}

/** Box-filter resample. Good enough for flat marks and dependency-free. */
export function resize(image, size) {
  const { width, height, rgba } = image
  const out = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4
          const alpha = rgba[i + 3] / 255
          // Premultiply, or transparent pixels drag colour into the edges.
          r += rgba[i] * alpha
          g += rgba[i + 1] * alpha
          b += rgba[i + 2] * alpha
          a += alpha
          n++
        }
      }

      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round((a / n) * 255)
    }
  }

  return { width: size, height: size, rgba: out }
}
