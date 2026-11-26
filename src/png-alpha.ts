import { inflateSync } from "node:zlib"

// Pixel counts by alpha value: transparent is alpha 0, opaque is the maximum for the bit depth, and semi-transparent is
// everything between.
type MeasuredAlpha = {
  status: "measured"
  totalPixels: number
  transparentPixels: number
  semiTransparentPixels: number
  opaquePixels: number
}

export type PngAlpha = MeasuredAlpha | { status: "no-alpha" } | { status: "unmeasured"; reason: string }

// Decoded scanlines above this size are not inflated, so a small compressed stream cannot claim gigabytes of memory.
const MAX_DECODED_BYTES = 64 * 1024 * 1024
// IDAT data is retained and concatenated before inflating, so its chunk count and total size are bounded too.
const MAX_IDAT_CHUNKS = 4096
const MAX_COMPRESSED_BYTES = MAX_DECODED_BYTES

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

type PngChunks = {
  width: number
  height: number
  bitDepth: number
  colorType: number
  compressionMethod: number
  filterMethod: number
  interlace: number
  hasTransparencyChunk: boolean
  idat: Uint8Array[]
}

// Walks the chunk list from the signature to IEND with bounds checks. Returns a reason instead of throwing when the
// structure is not a complete PNG. Chunk CRCs are not checked.
function readChunks(bytes: Uint8Array): PngChunks | string {
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) return "not a PNG signature"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  let header: Omit<PngChunks, "hasTransparencyChunk" | "idat"> | undefined
  let hasTransparencyChunk = false
  const idat: Uint8Array[] = []
  let compressedBytes = 0
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const name = type(offset + 4)
    const dataStart = offset + 8
    if (dataStart + length + 4 > bytes.length) return "truncated PNG chunk"
    if (!header) {
      if (name !== "IHDR" || length !== 13) return "missing PNG IHDR chunk"
      header = {
        width: view.getUint32(dataStart),
        height: view.getUint32(dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        compressionMethod: bytes[dataStart + 10],
        filterMethod: bytes[dataStart + 11],
        interlace: bytes[dataStart + 12],
      }
    } else if (name === "tRNS") {
      hasTransparencyChunk = true
    } else if (name === "IDAT") {
      compressedBytes += length
      if (idat.length >= MAX_IDAT_CHUNKS) return "too many PNG IDAT chunks"
      if (compressedBytes > MAX_COMPRESSED_BYTES) return "PNG image data too large to measure"
      idat.push(bytes.subarray(dataStart, dataStart + length))
    } else if (name === "IEND") {
      return { ...header, hasTransparencyChunk, idat }
    }
    offset = dataStart + length + 4
  }
  return "truncated PNG chunk list"
}

// RFC 2083 section 4.1.1 defines only compression method 0 (deflate) and filter method 0 (adaptive, five filter types).
function hasStandardMethods(png: PngChunks): boolean {
  return png.compressionMethod === 0 && png.filterMethod === 0
}

// True when the PNG declares alpha: a grayscale-alpha or RGBA color type, or a tRNS chunk. False for anything that is
// not a complete PNG chunk list with the standard compression and filter methods.
export function pngHasAlphaChannel(bytes: Uint8Array): boolean {
  const png = readChunks(bytes)
  return (
    typeof png !== "string" &&
    hasStandardMethods(png) &&
    (png.colorType === 4 || png.colorType === 6 || png.hasTransparencyChunk)
  )
}

// Counts pixels by alpha value for non-interlaced 8- or 16-bit grayscale-alpha and RGBA PNGs. Other alpha sources
// (tRNS, interlacing) and malformed data are reported as unmeasured; this never throws, so a measurement failure cannot
// block saving a valid image.
export function inspectPngAlpha(bytes: Uint8Array): PngAlpha {
  try {
    return measure(bytes)
  } catch {
    return { status: "unmeasured", reason: "the PNG data could not be decoded" }
  }
}

function measure(bytes: Uint8Array): PngAlpha {
  const png = readChunks(bytes)
  if (typeof png === "string") return { status: "unmeasured", reason: png }
  const { width, height, bitDepth, colorType } = png
  if (!hasStandardMethods(png)) return { status: "unmeasured", reason: "unknown PNG compression or filter method" }
  if (png.hasTransparencyChunk) return { status: "unmeasured", reason: "tRNS transparency is not measured" }
  if (colorType === 0 || colorType === 2 || colorType === 3) return { status: "no-alpha" }
  if (colorType !== 4 && colorType !== 6) return { status: "unmeasured", reason: `unknown color type ${colorType}` }
  if (bitDepth !== 8 && bitDepth !== 16) return { status: "unmeasured", reason: `unsupported bit depth ${bitDepth}` }
  if (png.interlace !== 0) return { status: "unmeasured", reason: "interlaced PNG" }
  if (width === 0 || height === 0) return { status: "unmeasured", reason: "zero dimensions" }

  const sampleBytes = bitDepth / 8
  const bytesPerPixel = (colorType === 4 ? 2 : 4) * sampleBytes
  const rowBytes = width * bytesPerPixel
  const expectedLength = height * (1 + rowBytes)
  if (expectedLength > MAX_DECODED_BYTES) return { status: "unmeasured", reason: "image too large to measure" }

  let decoded: Uint8Array
  try {
    decoded = inflateSync(Buffer.concat(png.idat), { maxOutputLength: expectedLength })
  } catch {
    return { status: "unmeasured", reason: "image data could not be inflated" }
  }
  if (decoded.length !== expectedLength) return { status: "unmeasured", reason: "image data has the wrong length" }

  let previous = new Uint8Array(rowBytes)
  let current = new Uint8Array(rowBytes)
  let transparentPixels = 0
  let opaquePixels = 0
  const maxAlpha = bitDepth === 8 ? 0xff : 0xffff
  const alphaOffset = bytesPerPixel - sampleBytes
  for (let y = 0; y < height; y++) {
    const start = y * (1 + rowBytes)
    const filter = decoded[start]
    if (filter > 4) return { status: "unmeasured", reason: `unknown scanline filter ${filter}` }
    for (let i = 0; i < rowBytes; i++) {
      const x = decoded[start + 1 + i]
      const a = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0
      const b = previous[i]
      const c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      current[i] = (x + predictor) & 0xff
    }
    for (let i = alphaOffset; i < rowBytes; i += bytesPerPixel) {
      const alpha = sampleBytes === 1 ? current[i] : (current[i] << 8) | current[i + 1]
      if (alpha === 0) transparentPixels++
      else if (alpha === maxAlpha) opaquePixels++
    }
    ;[previous, current] = [current, previous]
  }
  const totalPixels = width * height
  return {
    status: "measured",
    totalPixels,
    transparentPixels,
    semiTransparentPixels: totalPixels - transparentPixels - opaquePixels,
    opaquePixels,
  }
}
