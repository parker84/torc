/**
 * Builds the macOS icon from assets/logo.png — the CN Tower mark shared with
 * torcrime.
 *
 *   node scripts/make-icon.mjs
 *
 * The mark is a circle on a transparent field, which is wrong twice over for a
 * dock icon: macOS stopped masking icons in Big Sur, so the art has to *be* the
 * rounded square, and `sips` flattens transparency to white on resize — which
 * is where the white ring around the circle came from. So the plate is
 * composited in first, and every resample goes through lib/png.mjs, which
 * premultiplies and leaves the alpha channel alone.
 *
 * The source is 512px, so the 1024 slot is an upscale. It holds up because the
 * mark is flat, but if a larger original ever turns up, drop it in and rerun.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, onPlate, resize } from './lib/png.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'assets', 'logo.png')
const BUILD = join(ROOT, 'build')
const ICONSET = join(BUILD, 'icon.iconset')

/** The mark's own navy, so the plate and the circle read as one shape. */
const PLATE = [22, 22, 41]

if (!existsSync(SOURCE)) {
  console.error(`missing ${SOURCE}`)
  process.exit(1)
}

// The names and sizes iconutil expects for a complete .icns.
const SLOTS = [
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

/**
 * Bilinear, on premultiplied alpha. lib/png.mjs's box filter averages whole
 * source pixels, which degenerates to nearest-neighbour when asked to *grow* an
 * image — fine for the downscales, visibly stepped on the 1024 slot.
 */
function upscale(image, size) {
  const { width, height, rgba } = image
  const out = Buffer.alloc(size * size * 4)
  const at = (x, y, c) => rgba[(y * width + x) * 4 + c]

  for (let y = 0; y < size; y++) {
    const fy = ((y + 0.5) * height) / size - 0.5
    const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)))
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = Math.min(1, Math.max(0, fy - y0))

    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) * width) / size - 0.5
      const x0 = Math.min(width - 1, Math.max(0, Math.floor(fx)))
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = Math.min(1, Math.max(0, fx - x0))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [sx, sy, w] of [
        [x0, y0, (1 - wx) * (1 - wy)],
        [x1, y0, wx * (1 - wy)],
        [x0, y1, (1 - wx) * wy],
        [x1, y1, wx * wy],
      ]) {
        const alpha = at(sx, sy, 3) / 255
        r += at(sx, sy, 0) * alpha * w
        g += at(sx, sy, 1) * alpha * w
        b += at(sx, sy, 2) * alpha * w
        a += alpha * w
      }

      const i = (y * size + x) * 4
      out[i] = a > 0 ? Math.round(r / a) : 0
      out[i + 1] = a > 0 ? Math.round(g / a) : 0
      out[i + 2] = a > 0 ? Math.round(b / a) : 0
      out[i + 3] = Math.round(a * 255)
    }
  }

  return { width: size, height: size, rgba: out }
}

function scaleTo(image, size) {
  if (size === image.width) return image
  return size < image.width ? resize(image, size) : upscale(image, size)
}

const plated = onPlate(decodePng(readFileSync(SOURCE)), PLATE)

rmSync(ICONSET, { recursive: true, force: true })
mkdirSync(ICONSET, { recursive: true })

for (const [size, name] of SLOTS) {
  const { width, height, rgba } = scaleTo(plated, size)
  writeFileSync(join(ICONSET, name), encodePng(width, height, rgba))
}

// electron-builder wants a plain png; dev uses it for the dock icon.
const large = scaleTo(plated, 1024)
writeFileSync(join(BUILD, 'icon.png'), encodePng(large.width, large.height, large.rgba))

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(BUILD, 'icon.icns')])
console.log('wrote build/icon.icns, build/icon.png')
