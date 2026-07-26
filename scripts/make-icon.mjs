/**
 * Generates the Torc app icon with no image dependencies — Node's zlib is
 * enough to write a valid PNG, and macOS ships iconutil to bundle the .icns.
 *
 * The mark: the CN Tower in Torc magenta, struck by a lightning bolt. Toronto
 * plus the electricity that turns the thing — a sibling to the torcrime logo
 * rather than a copy of it. Shapes are deliberately chunky so the silhouette
 * still reads at 16px, where fine detail on the SkyPod bands would mud out.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')
const ICONSET = join(BUILD, 'icon.iconset')

// ── PNG encoding ───────────────────────────────────────────────────────────
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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter type: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── palette ────────────────────────────────────────────────────────────────
const BG_CORE = [0x24, 0x1b, 0x3a] // lit centre of the backdrop
const BG_EDGE = [0x14, 0x0f, 0x1f] // vignetted corners
const TOWER_LIT = [0xff, 0x5c, 0xc4] // left face, catching the strike
const TOWER_MID = [0xf9, 0x2a, 0xad] // torc magenta
const TOWER_SHADE = [0xa8, 0x18, 0x74] // right face
const SEAM = [0x2a, 0x0f, 0x22] // band separations on the pod
const BOLT_CORE = [0xe8, 0xff, 0xff] // hot centre
const BOLT_EDGE = [0x36, 0xf9, 0xf6] // synthwave cyan

const SS = 5 // supersampling factor

// ── geometry helpers (all in 0..1 space, y growing downward) ───────────────
function mix(a, b, t) {
  const k = Math.min(Math.max(t, 0), 1)
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** Vertically symmetric tapered column: half-width interpolates top → bottom. */
function inColumn(x, y, yTop, yBottom, halfTop, halfBottom) {
  if (y < yTop || y > yBottom) return false
  const t = (y - yTop) / (yBottom - yTop)
  return Math.abs(x - 0.5) <= halfTop + (halfBottom - halfTop) * t
}

function inEllipse(x, y, cx, cy, rx, ry) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
}

/** Shortest distance from a point to a line segment. */
function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  const t = lenSq === 0 ? 0 : Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / lenSq, 0), 1)
  return { dist: Math.hypot(x - (ax + t * dx), y - (ay + t * dy)), t }
}

/**
 * The bolt is a stroked polyline rather than a filled cartoon zigzag: angular,
 * tapering, and — the point — its last segment terminates *on* the antenna, so
 * the tower is being struck rather than merely stood next to. The real CN Tower
 * is a lightning rod that takes about 75 hits a year.
 */
const IMPACT = [0.492, 0.152]
const BOLT_PATH = [
  [0.09, 0.035],
  [0.2, 0.125],
  [0.135, 0.15],
  [0.265, 0.2],
  [0.2, 0.225],
  [0.35, 0.105],
  IMPACT,
]
const BOLT_WIDTH_START = 0.021
const BOLT_WIDTH_END = 0.0065
const GLOW = 0.042

/** Distance to the bolt, plus the half-width at that point along the path. */
function boltDistance(x, y) {
  let best = { dist: Infinity, half: BOLT_WIDTH_END }
  const segments = BOLT_PATH.length - 1
  for (let i = 0; i < segments; i++) {
    const [ax, ay] = BOLT_PATH[i]
    const [bx, by] = BOLT_PATH[i + 1]
    const { dist, t } = distToSegment(x, y, ax, ay, bx, by)
    if (dist >= best.dist) continue
    const along = (i + t) / segments
    best = {
      dist,
      half: BOLT_WIDTH_START + (BOLT_WIDTH_END - BOLT_WIDTH_START) * along,
    }
  }
  return best
}

/**
 * Tower silhouette. Proportions follow the torcrime mark — long thin antenna,
 * collar, tapering shaft, banded SkyPod, flared base — but built from tighter
 * geometry with visible seams so it reads as drawn rather than doodled.
 */
function towerPart(x, y) {
  // Antenna and its collar.
  if (inColumn(x, y, 0.05, 0.2, 0.008, 0.014)) return 'tower'
  if (inEllipse(x, y, 0.5, 0.202, 0.026, 0.011)) return 'tower'
  // Upper shaft.
  if (inColumn(x, y, 0.208, 0.44, 0.017, 0.023)) return 'tower'

  // SkyPod: a flat-topped bulge split into bands by thin dark seams.
  const inPod =
    (y >= 0.44 && inEllipse(x, y, 0.5, 0.532, 0.092, 0.098)) ||
    inColumn(x, y, 0.44, 0.47, 0.048, 0.074)
  if (inPod) {
    for (const seam of [0.474, 0.508, 0.556]) {
      if (Math.abs(y - seam) < 0.0055) return 'seam'
    }
    return 'tower'
  }

  // Lower shaft flaring into the base, with a seam where the flare begins.
  if (inColumn(x, y, 0.628, 0.95, 0.024, 0.072)) {
    return Math.abs(y - 0.86) < 0.005 ? 'seam' : 'tower'
  }
  return null
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = 0.225 // rounded-square corner radius, in 0..1 space

  const inCanvas = (x, y) => {
    const inset = 0.03
    const min = inset
    const max = 1 - inset
    if (x < min || x > max || y < min || y > max) return false
    const cx = Math.min(Math.max(x, min + radius), max - radius)
    const cy = Math.min(Math.max(y, min + radius), max - radius)
    if (x >= min + radius && x <= max - radius) return true
    if (y >= min + radius && y <= max - radius) return true
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let canvasHits = 0
      const acc = [0, 0, 0]

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          if (!inCanvas(x, y)) continue
          canvasHits++

          // Backdrop: radial falloff so the strike reads as the light source.
          const fromImpact = Math.hypot(x - IMPACT[0], y - IMPACT[1])
          let color = mix(BG_CORE, BG_EDGE, (fromImpact - 0.18) / 0.62)

          const part = towerPart(x, y)
          if (part === 'seam') {
            color = SEAM
          } else if (part === 'tower') {
            // Light falls from the strike on the upper left.
            const shade = (x - 0.5) / 0.09
            color = shade < 0 ? mix(TOWER_LIT, TOWER_MID, shade + 1) : mix(TOWER_MID, TOWER_SHADE, shade)
          }

          // Glow, then the hot core on top of everything.
          const { dist, half } = boltDistance(x, y)
          if (dist < half + GLOW) {
            const falloff = 1 - (dist - half) / GLOW
            color = mix(color, BOLT_EDGE, Math.min(Math.max(falloff, 0), 1) * 0.55)
          }
          // A flash where the bolt meets the steel.
          const flash = 1 - fromImpact / 0.075
          if (flash > 0) color = mix(color, BOLT_CORE, flash * 0.85)
          if (dist < half) {
            color = mix(BOLT_EDGE, BOLT_CORE, 1 - dist / half)
          }

          acc[0] += color[0]
          acc[1] += color[1]
          acc[2] += color[2]
        }
      }

      if (canvasHits === 0) continue
      const offset = (py * size + px) * 4
      for (let i = 0; i < 3; i++) rgba[offset + i] = Math.round(acc[i] / canvasHits)
      rgba[offset + 3] = Math.round((canvasHits / (SS * SS)) * 255)
    }
  }

  return encodePng(size, rgba)
}

// ── outputs ────────────────────────────────────────────────────────────────
rmSync(ICONSET, { recursive: true, force: true })
mkdirSync(ICONSET, { recursive: true })

const ICONSET_SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]

const cache = new Map()
const png = (size) => {
  if (!cache.has(size)) cache.set(size, render(size))
  return cache.get(size)
}

for (const [size, name] of ICONSET_SIZES) writeFileSync(join(ICONSET, name), png(size))

// electron-builder wants a plain 1024 png; dev uses it for the dock icon.
writeFileSync(join(BUILD, 'icon.png'), png(1024))

try {
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(BUILD, 'icon.icns')])
  console.log('wrote build/icon.icns, build/icon.png')
} catch (error) {
  console.warn('iconutil failed; build/icon.png is still available:', error.message)
}
