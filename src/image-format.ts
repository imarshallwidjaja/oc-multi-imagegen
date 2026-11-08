import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { imageSize } from "image-size"
import { inspectSvg } from "./svg"

// The formats a tool can save. Each image tool declares the ones it saves; its `out` argument names the same list.
export type OutputFormat = "png" | "jpeg" | "webp" | "gif" | "svg"

export const RASTER_FORMATS = ["png", "jpeg", "webp"] as const satisfies readonly OutputFormat[]

// The first extension is the one a file gets; the others are accepted as already matching.
const FORMATS: Record<OutputFormat, { mime: string; name: string; extensions: readonly string[] }> = {
  png: { mime: "image/png", name: "PNG", extensions: [".png"] },
  jpeg: { mime: "image/jpeg", name: "JPEG", extensions: [".jpg", ".jpeg"] },
  webp: { mime: "image/webp", name: "WebP", extensions: [".webp"] },
  gif: { mime: "image/gif", name: "GIF", extensions: [".gif"] },
  svg: { mime: "image/svg+xml", name: "SVG", extensions: [".svg"] },
}

export function formatName(format: OutputFormat): string {
  return FORMATS[format].name
}

// "PNG, JPEG or WebP"
export function listFormatNames(formats: readonly OutputFormat[]): string {
  const names = formats.map(formatName)
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`
}

// Text whose first non-blank character, after an optional UTF-8 byte order mark, is "<" may be an SVG document.
function startsLikeMarkup(bytes: Buffer): boolean {
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index++
  return bytes[index] === 0x3c
}

export type InspectedImage = { format: OutputFormat; description: string }

// Detects the format among those accepted and reads its size. Header inspection is not a full corruption check. A GIF
// header gives the logical screen size, not proof of animation, and an SVG's viewBox or width and height are vector
// units, not pixels.
export async function inspectImage(image: Uint8Array, accepted: readonly OutputFormat[]): Promise<InspectedImage> {
  const bytes = Buffer.from(image.buffer, image.byteOffset, image.byteLength)
  const detected = (await fileTypeFromBuffer(bytes).catch(() => undefined))?.mime
  const format = accepted.find((candidate) => candidate !== "svg" && FORMATS[candidate].mime === detected)
  if (!format) {
    // file-type reports SVG as unknown, or as XML when it starts with an XML declaration.
    if (
      accepted.includes("svg") &&
      (detected === undefined || detected === "application/xml") &&
      startsLikeMarkup(bytes)
    ) {
      const svg = inspectSvg(bytes)
      if (!svg.ok) {
        throw new Error(
          `the backend returned an SVG this plugin will not save: ${svg.reason}. Only static vector documents without scripts, external resources or embedded rasters are saved; nothing was saved`,
        )
      }
      return { format: "svg", description: `SVG, a vector document with ${svg.geometry} (vector units, not pixels)` }
    }
    throw new Error(
      `the backend returned an unsupported image type (${detected ?? "unknown"}); expected ${listFormatNames(accepted)}; nothing was saved`,
    )
  }
  let size: ReturnType<typeof imageSize>
  try {
    // image-size's VP8L bitwise reads treat missing dimension bytes as zeros.
    // The 20-byte container/chunk prefix needs 5 bytes for VP8L, or 10 for VP8/VP8X.
    if (format === "webp" && bytes.length < (bytes.toString("ascii", 12, 16) === "VP8L" ? 25 : 30)) {
      throw new Error("incomplete dimension header")
    }
    size = imageSize(bytes)
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      throw new Error("invalid dimensions")
    }
  } catch {
    // Parser errors can include provider-controlled text; report only the detected MIME type.
    throw new Error(`the backend returned malformed ${detected} image headers or dimensions; nothing was saved`)
  }
  const pixels = `${size.width}x${size.height} pixels`
  return {
    format,
    description:
      format === "gif"
        ? `GIF, ${pixels} (the header's logical screen size; frames and animation are not checked)`
        : `${FORMATS[format].name}, ${pixels}`,
  }
}

// The path a file of `format` is saved to. A matching extension is kept, including case variants; only an extension of
// an accepted format is replaced, and any other suffix is kept with the actual extension appended.
export function pathForFormat(requested: string, format: OutputFormat, accepted: readonly OutputFormat[]): string {
  const { extensions } = FORMATS[format]
  const requestedExtension = path.extname(requested)
  const lowerExtension = requestedExtension.toLowerCase()
  if (extensions.includes(lowerExtension)) return requested
  const replaceable = accepted.flatMap((candidate) => FORMATS[candidate].extensions)
  return replaceable.includes(lowerExtension)
    ? requested.slice(0, -requestedExtension.length) + extensions[0]
    : requested + extensions[0]
}
