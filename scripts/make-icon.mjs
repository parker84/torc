/**
 * Builds the macOS icon from assets/logo.png — the CN Tower mark shared with
 * torcrime. Uses the tools macOS already ships (sips to resize, iconutil to
 * bundle) so there's no image dependency to install.
 *
 *   node scripts/make-icon.mjs
 *
 * The source is 512px, so the 1024 slot is an upscale. It holds up because the
 * mark is flat, but if a larger original ever turns up, drop it in and rerun.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'assets', 'logo.png')
const BUILD = join(ROOT, 'build')
const ICONSET = join(BUILD, 'icon.iconset')

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

rmSync(ICONSET, { recursive: true, force: true })
mkdirSync(ICONSET, { recursive: true })

for (const [size, name] of SLOTS) {
  const out = join(ICONSET, name)
  if (size === 512) {
    // Same size as the source; copying avoids a needless resample.
    copyFileSync(SOURCE, out)
    continue
  }
  execFileSync('sips', ['-z', String(size), String(size), SOURCE, '--out', out], {
    stdio: 'ignore',
  })
}

// electron-builder wants a plain png; dev uses it for the dock icon.
execFileSync('sips', ['-z', '1024', '1024', SOURCE, '--out', join(BUILD, 'icon.png')], {
  stdio: 'ignore',
})

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(BUILD, 'icon.icns')])
console.log('wrote build/icon.icns, build/icon.png')
