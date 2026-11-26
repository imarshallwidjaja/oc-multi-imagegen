import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { inspectImage } from "../../src/image-format"
import { inspectPngAlpha, pngHasAlphaChannel } from "../../src/png-alpha"
import { LOSSLESS_WEBP_BUFFER, LOSSY_WEBP_BUFFER, WEBP_BUFFER } from "./fixtures"

const asset = (name: string) => readFileSync(path.join(import.meta.dir, "../../docs/images", name))

function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace = 0,
  compressionMethod = 0,
  filterMethod = 0,
): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data.set([bitDepth, colorType, compressionMethod, filterMethod, interlace], 8)
  return chunk("IHDR", data)
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function png(header: Buffer, idat: Uint8Array, extra: Buffer[] = []): Buffer {
  return Buffer.concat([SIGNATURE, header, ...extra, chunk("IDAT", idat), chunk("IEND")])
}

// Encodes raw rows of interleaved samples (already big-endian for 16-bit) with one filter type for every row.
function encode(width: number, rows: number[][], bitDepth: 8 | 16, colorType: 4 | 6, filter: number): Buffer {
  return png(ihdr(width, rows.length, bitDepth, colorType), filteredData(width, rows, bitDepth, colorType, filter))
}

// The encoder side of RFC 2083 filtering, applied to raw scanlines so the decoder has to invert it.
function filterRow(filter: number, row: Uint8Array, previous: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length + 1)
  out[0] = filter
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0
    const b = previous[i]
    const c = i >= bpp ? previous[i - bpp] : 0
    const paeth = () => {
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    const predictor = [0, a, b, (a + b) >> 1, filter === 4 ? paeth() : 0][filter]
    out[i + 1] = (row[i] - predictor) & 0xff
  }
  return out
}

function filteredData(width: number, rows: number[][], bitDepth: 8 | 16, colorType: 4 | 6, filter: number): Buffer {
  const bpp = ((colorType === 4 ? 2 : 4) * bitDepth) / 8
  let previous = new Uint8Array(width * bpp)
  const filtered = rows.map((values) => {
    const row = Uint8Array.from(values)
    const out = filterRow(filter, row, previous, bpp)
    previous = row
    return out
  })
  return deflateSync(Buffer.concat(filtered))
}

// 3x3 RGBA with varied colour so every predictor contributes, and a known alpha mix: 3 transparent, 3 semi, 3 opaque.
const RGBA_ROWS = [
  [10, 200, 30, 0, 250, 5, 128, 255, 7, 99, 254, 1],
  [200, 10, 90, 128, 3, 3, 3, 0, 255, 255, 255, 255],
  [1, 2, 3, 255, 9, 180, 77, 0, 140, 60, 20, 254],
]
const RGBA_COUNTS = {
  status: "measured",
  totalPixels: 9,
  transparentPixels: 3,
  semiTransparentPixels: 3,
  opaquePixels: 3,
} as const

describe("inspectPngAlpha", () => {
  test.each([
    ["None", 0],
    ["Sub", 1],
    ["Up", 2],
    ["Average", 3],
    ["Paeth", 4],
  ])("counts 8-bit RGBA alpha through the %s filter", (_name, filter) => {
    expect(inspectPngAlpha(encode(3, RGBA_ROWS, 8, 6, filter))).toEqual(RGBA_COUNTS)
  })

  test.each([1, 2, 4])("reads an opaque image as opaque when filter %i leaves zero deltas", (filter) => {
    const rows = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => [40, 40, 40, 255]).flat())
    expect(inspectPngAlpha(encode(5, rows, 8, 6, filter))).toEqual({
      status: "measured",
      totalPixels: 20,
      transparentPixels: 0,
      semiTransparentPixels: 0,
      opaquePixels: 20,
    })
  })

  test("compares 16-bit alpha against 65535, not either byte alone", () => {
    // Alpha 0x0000, 0x00ff, 0xff00 and 0xffff: only the first is transparent and only the last opaque.
    const pixel = (alphaHigh: number, alphaLow: number) => [1, 2, 3, 4, 5, 6, alphaHigh, alphaLow]
    const rows = [
      [...pixel(0, 0), ...pixel(0, 255)],
      [...pixel(255, 0), ...pixel(255, 255)],
    ]
    for (const filter of [0, 1, 4]) {
      expect(inspectPngAlpha(encode(2, rows, 16, 6, filter))).toEqual({
        status: "measured",
        totalPixels: 4,
        transparentPixels: 1,
        semiTransparentPixels: 2,
        opaquePixels: 1,
      })
    }
  })

  test("counts 16-bit grayscale-alpha pixels with a four-byte stride", () => {
    // Gray then alpha, both big-endian: alpha 0x0000, 0x00ff, 0xff00 and 0xffff.
    const rows = [
      [0, 9, 0, 0, 0, 9, 0, 255],
      [0, 9, 255, 0, 0, 9, 255, 255],
    ]
    for (const filter of [0, 1, 4]) {
      expect(inspectPngAlpha(encode(2, rows, 16, 4, filter))).toEqual({
        status: "measured",
        totalPixels: 4,
        transparentPixels: 1,
        semiTransparentPixels: 2,
        opaquePixels: 1,
      })
    }
  })

  test("counts 8-bit grayscale-alpha pixels with a two-byte stride", () => {
    const rows = [
      [10, 0, 20, 255, 30, 77],
      [40, 255, 50, 0, 60, 0],
    ]
    expect(inspectPngAlpha(encode(3, rows, 8, 4, 4))).toEqual({
      status: "measured",
      totalPixels: 6,
      transparentPixels: 3,
      semiTransparentPixels: 1,
      opaquePixels: 2,
    })
  })

  // Expected counts come from ImageMagick 7 (`magick fox-postmaster-icon.png -alpha extract -depth 8 gray:-`, then
  // counting 0 and 255 bytes). The file is filtered with Sub, Up, Average and Paeth rows by its encoder.
  test("matches an independent decoder on the repository's RGBA icon", () => {
    expect(inspectPngAlpha(asset("fox-postmaster-icon.png"))).toEqual({
      status: "measured",
      totalPixels: 1254 * 1254,
      transparentPixels: 875997,
      semiTransparentPixels: 696107,
      opaquePixels: 412,
    })
  })

  test("reports no alpha for a colour type without an alpha channel or tRNS", () => {
    const rgb = asset("forest-post-office.png")
    expect(inspectPngAlpha(rgb)).toEqual({ status: "no-alpha" })
    expect(pngHasAlphaChannel(rgb)).toBe(false)
  })

  test("leaves palette transparency from tRNS unmeasured but reports the alpha", () => {
    const palette = png(ihdr(1, 1, 8, 3), deflateSync(Buffer.from([0, 0])), [
      chunk("PLTE", Buffer.from([0, 0, 0])),
      chunk("tRNS", Buffer.from([0])),
    ])
    expect(inspectPngAlpha(palette)).toEqual({ status: "unmeasured", reason: "tRNS transparency is not measured" })
    expect(pngHasAlphaChannel(palette)).toBe(true)
    expect(pngHasAlphaChannel(encode(3, RGBA_ROWS, 8, 6, 0))).toBe(true)
  })

  test("leaves interlaced PNGs unmeasured", () => {
    const interlaced = png(ihdr(1, 1, 8, 6, 1), deflateSync(Buffer.from([0, 1, 2, 3, 0])))
    expect(inspectPngAlpha(interlaced)).toEqual({ status: "unmeasured", reason: "interlaced PNG" })
  })

  test("refuses to inflate a header that declares more than the decode cap", () => {
    const huge = png(ihdr(100000, 100000, 8, 6), deflateSync(Buffer.alloc(16)))
    expect(inspectPngAlpha(huge)).toEqual({ status: "unmeasured", reason: "image too large to measure" })
  })

  test("stops inflating at the declared size when the stream expands further", () => {
    // 2x2 RGBA declares 2 * (1 + 8) = 18 bytes of scanlines; the stream holds one byte more.
    const bomb = png(ihdr(2, 2, 8, 6), deflateSync(Buffer.alloc(19)))
    expect(inspectPngAlpha(bomb)).toEqual({ status: "unmeasured", reason: "image data could not be inflated" })
  })

  test("leaves image data unmeasured beyond the IDAT chunk count cap", () => {
    const rows = filteredData(3, RGBA_ROWS, 8, 6, 0)
    const empty = Array.from({ length: 4096 }, () => chunk("IDAT"))
    const atCap = Buffer.concat([SIGNATURE, ihdr(3, 3, 8, 6), ...empty.slice(1), chunk("IDAT", rows), chunk("IEND")])
    expect(inspectPngAlpha(atCap)).toEqual(RGBA_COUNTS)
    const overCap = Buffer.concat([SIGNATURE, ihdr(3, 3, 8, 6), ...empty, chunk("IDAT", rows), chunk("IEND")])
    expect(inspectPngAlpha(overCap)).toEqual({ status: "unmeasured", reason: "too many PNG IDAT chunks" })
  })

  test("leaves image data unmeasured beyond the compressed size cap", () => {
    // Two IDAT chunks of 32 MiB + 1 bytes each, written in place: each is under the 64 MiB cap, their sum is over it.
    // CRCs are not checked, so they stay zero.
    const header = ihdr(1, 1, 8, 6)
    const length = 32 * 1024 * 1024 + 1
    const bytes = Buffer.alloc(SIGNATURE.length + header.length + 2 * (12 + length) + 12)
    SIGNATURE.copy(bytes, 0)
    header.copy(bytes, SIGNATURE.length)
    let offset = SIGNATURE.length + header.length
    for (let index = 0; index < 2; index++) {
      bytes.writeUInt32BE(length, offset)
      bytes.write("IDAT", offset + 4, "ascii")
      offset += 12 + length
    }
    bytes.write("IEND", offset + 4, "ascii")
    expect(inspectPngAlpha(bytes)).toEqual({ status: "unmeasured", reason: "PNG image data too large to measure" })
  })

  test.each([
    ["compression", 1, 0],
    ["filter", 0, 1],
  ])("leaves a PNG with a nonzero %s method unmeasured and without declared alpha", (_name, compression, filter) => {
    const rgba = encode(3, RGBA_ROWS, 8, 6, 0)
    const header = ihdr(3, 3, 8, 6, 0, compression, filter)
    const bytes = Buffer.concat([SIGNATURE, header, rgba.subarray(SIGNATURE.length + header.length)])
    expect(inspectPngAlpha(bytes)).toEqual({ status: "unmeasured", reason: "unknown PNG compression or filter method" })
    expect(pngHasAlphaChannel(bytes)).toBe(false)
  })

  test("reports short image data as unmeasured", () => {
    const short = png(ihdr(3, 3, 8, 6), deflateSync(Buffer.alloc(10)))
    expect(inspectPngAlpha(short)).toEqual({ status: "unmeasured", reason: "image data has the wrong length" })
  })

  test("reports malformed input as unmeasured without throwing", () => {
    const valid = encode(3, RGBA_ROWS, 8, 6, 4)
    const badLength = Buffer.from(valid)
    badLength.writeUInt32BE(0xfffffff0, 8 + 25)
    const brokenStructure = [
      [new Uint8Array(), "not a PNG signature"],
      [valid.subarray(0, valid.length - 14), "truncated PNG chunk"],
      [valid.subarray(0, 8 + 25), "truncated PNG chunk list"],
      [badLength, "truncated PNG chunk"],
      [Buffer.concat([SIGNATURE, chunk("IDAT")]), "missing PNG IHDR chunk"],
    ] as const
    for (const [bytes, reason] of brokenStructure) {
      expect(inspectPngAlpha(bytes)).toEqual({ status: "unmeasured", reason })
      expect(pngHasAlphaChannel(bytes)).toBe(false)
    }
    const brokenData = [
      [png(ihdr(1, 1, 8, 6), Buffer.from("not zlib")), "image data could not be inflated"],
      [png(ihdr(1, 1, 8, 6), deflateSync(Buffer.from([9, 0, 0, 0, 0]))), "unknown scanline filter 9"],
      [png(ihdr(1, 1, 4, 6), deflateSync(Buffer.alloc(3))), "unsupported bit depth 4"],
    ] as const
    for (const [bytes, reason] of brokenData) {
      expect(inspectPngAlpha(bytes)).toEqual({ status: "unmeasured", reason })
    }
  })
})

describe("inspectImage alpha summary", () => {
  const describePng = async (bytes: Uint8Array) => (await inspectImage(bytes, ["png", "webp"])).description

  test("reports exact zero and full shares and bounds small nonzero shares", async () => {
    // 200 pixels: one transparent, the rest opaque. 0.5% must not read as 0%, and 99.5% must not read as 100%.
    const rows = [Array.from({ length: 200 }, (_, x) => [5, 5, 5, x === 7 ? 0 : 255]).flat()]
    expect(await describePng(encode(200, rows, 8, 6, 1))).toBe(
      "PNG, 200x1 pixels, alpha: <1% transparent, 0% semi-transparent, >99% opaque",
    )
    expect(await describePng(encode(3, RGBA_ROWS, 8, 6, 4))).toBe(
      "PNG, 3x3 pixels, alpha: 33% transparent, 33% semi-transparent, 33% opaque",
    )
  })

  test("describes an opaque alpha channel, a missing channel and an unmeasured one", async () => {
    const opaque = encode(2, [[1, 2, 3, 255, 4, 5, 6, 255]], 8, 6, 0)
    expect(await describePng(opaque)).toBe(
      "PNG, 2x1 pixels, alpha channel present but 100% opaque (0 transparent pixels)",
    )
    expect(await describePng(asset("forest-post-office.png"))).toBe("PNG, 1672x941 pixels, no alpha channel")
    const interlaced = png(ihdr(1, 1, 8, 6, 1), deflateSync(Buffer.from([0, 1, 2, 3, 0])))
    expect(await describePng(interlaced)).toBe("PNG, 1x1 pixels, alpha not measured (interlaced PNG)")
  })

  test.each([
    ["VP8X with the alpha bit", Buffer.from(WEBP_BUFFER).fill(WEBP_BUFFER[20] | 0x10, 20, 21), true],
    ["VP8X without the alpha bit", WEBP_BUFFER, false],
    [
      "VP8L with alpha_is_used",
      (() => {
        const bytes = Buffer.from(LOSSLESS_WEBP_BUFFER)
        bytes.writeUInt32LE(bytes.readUInt32LE(21) | 0x10000000, 21)
        return bytes
      })(),
      true,
    ],
    ["VP8L without alpha_is_used", LOSSLESS_WEBP_BUFFER, false],
  ] as const)(
    "reads the WebP header alpha flag from %s without claiming pixel transparency",
    async (_name, bytes, flag) => {
      expect((await inspectImage(bytes, ["webp"])).description).toBe(
        flag
          ? "WebP, 3x2 pixels, alpha flag set in the WebP header (pixels not measured)"
          : "WebP, 3x2 pixels, no alpha flag in the WebP header (pixels not measured)",
      )
    },
  )

  test("reports no alpha for a lossy VP8 WebP", async () => {
    expect(await inspectImage(LOSSY_WEBP_BUFFER, ["webp"])).toEqual({
      format: "webp",
      description: "WebP, 3x2 pixels, no alpha channel",
    })
  })
})
