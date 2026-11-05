import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { imageSize } from "image-size"
import { inspectSvg } from "./svg"
import type { SavedImage } from "./types"

const MAX_OUTPUT_VERSION_SUFFIX = 999

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// maxVersion is injectable only so tests can reach the exhaustion branch cheaply; production callers use the default.
export async function pickNonOverwritePath(requested: string, maxVersion = MAX_OUTPUT_VERSION_SUFFIX): Promise<string> {
  if (!(await pathExists(requested))) return requested
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  for (let n = 2; n <= maxVersion; n++) {
    const candidate = path.join(dir, `${stem}-v${n}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${maxVersion})`,
  )
}

// The formats a tool can save. Codex and NanoGPT save rasters only; a backend that declares more lists them on its tool.
export type OutputFormat = "png" | "jpeg" | "webp" | "gif" | "svg"

export const RASTER_FORMATS: readonly OutputFormat[] = ["png", "jpeg", "webp"]

// The first extension is the one a file gets; the others are accepted as already matching.
const FORMATS: Record<OutputFormat, { mime: string; name: string; extensions: readonly string[] }> = {
  png: { mime: "image/png", name: "PNG", extensions: [".png"] },
  jpeg: { mime: "image/jpeg", name: "JPEG", extensions: [".jpg", ".jpeg"] },
  webp: { mime: "image/webp", name: "WebP", extensions: [".webp"] },
  gif: { mime: "image/gif", name: "GIF", extensions: [".gif"] },
  svg: { mime: "image/svg+xml", name: "SVG", extensions: [".svg"] },
}

// "PNG, JPEG or WebP"
export function listFormatNames(formats: readonly OutputFormat[]): string {
  const names = formats.map((format) => FORMATS[format].name)
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`
}

// Text whose first non-blank character, after an optional UTF-8 byte order mark, is "<" may be an SVG document.
function startsLikeMarkup(bytes: Buffer): boolean {
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index++
  return bytes[index] === 0x3c
}

type Inspected = { format: OutputFormat; description: string }

// Detects the format among those accepted and reads its size before anything is written. Header inspection is not a
// full corruption check. A GIF header gives the logical screen size, not proof of animation, and an SVG's viewBox or
// width and height are vector units, not pixels.
async function inspectImage(bytes: Buffer, accepted: readonly OutputFormat[]): Promise<Inspected> {
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

// Resolve the output path (relative to ctxDir unless absolute), then write the native image bytes. Only the formats
// the tool accepts are saved, with the extension of the detected format. Avoiding an overwrite is best-effort: the
// collision check and the write are not atomic, so a concurrent writer racing between them could still be clobbered.
// Returns the user-facing message alongside the saved path.
export async function saveGeneratedImage(
  out: string,
  ctxDir: string,
  base64: string,
  accepted: readonly OutputFormat[] = RASTER_FORMATS,
): Promise<SavedImage> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(ctxDir, out)
  const bytes = Buffer.from(base64, "base64")
  const { format, description } = await inspectImage(bytes, accepted)
  const { name, extensions } = FORMATS[format]
  const requestedExtension = path.extname(requestedPath)
  const lowerExtension = requestedExtension.toLowerCase()
  // Only extensions of the accepted formats are replaced; any other suffix is kept and the actual extension appended.
  const replaceable = accepted.flatMap((candidate) => FORMATS[candidate].extensions)
  const targetPath = extensions.includes(lowerExtension)
    ? requestedPath
    : replaceable.includes(lowerExtension)
      ? requestedPath.slice(0, -requestedExtension.length) + extensions[0]
      : requestedPath + extensions[0]
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const savedPath = await pickNonOverwritePath(targetPath)
  await fs.writeFile(savedPath, bytes)
  const versioned = savedPath !== targetPath
  const extensionNote =
    targetPath !== requestedPath
      ? ` The requested path ${requestedPath} was adjusted to ${targetPath} to match the ${name} bytes.`
      : ""
  const versionNote = versioned
    ? ` The target path ${targetPath} already existed; the new image was versioned to avoid overwriting it.`
    : ""
  return {
    savedPath,
    versioned,
    message: `Generated image saved to ${savedPath}. The image is ${description}.${extensionNote}${versionNote}`,
  }
}
