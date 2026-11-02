import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { imageSize } from "image-size"
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

// Resolve the output path (relative to ctxDir unless absolute), then write the
// native image bytes. Avoiding an overwrite is best-effort: the collision check and the
// write are not atomic, so a concurrent writer racing between them could still be
// clobbered. Returns the user-facing message alongside the saved path.
export async function saveGeneratedImage(out: string, ctxDir: string, base64: string): Promise<SavedImage> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(ctxDir, out)
  const bytes = Buffer.from(base64, "base64")
  // Detect the type and read header dimensions before any write. This is not a full corruption check.
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined)
  const format = detected?.mime
  if (format !== "image/png" && format !== "image/jpeg" && format !== "image/webp") {
    throw new Error(
      `the backend returned an unsupported image type (${format ?? "unknown"}); expected PNG, JPEG or WebP; nothing was saved`,
    )
  }
  let size: ReturnType<typeof imageSize>
  try {
    // image-size's VP8L bitwise reads treat missing dimension bytes as zeros.
    // The 20-byte container/chunk prefix needs 5 bytes for VP8L, or 10 for VP8/VP8X.
    if (format === "image/webp" && bytes.length < (bytes.toString("ascii", 12, 16) === "VP8L" ? 25 : 30)) {
      throw new Error("incomplete dimension header")
    }
    size = imageSize(bytes)
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      throw new Error("invalid dimensions")
    }
  } catch {
    // Parser errors can include provider-controlled text; report only the detected MIME type.
    throw new Error(`the backend returned malformed ${format} image headers or dimensions; nothing was saved`)
  }
  const extension = format === "image/jpeg" ? ".jpg" : format === "image/webp" ? ".webp" : ".png"
  const requestedExtension = path.extname(requestedPath)
  const lowerExtension = requestedExtension.toLowerCase()
  const matches = lowerExtension === extension || (format === "image/jpeg" && lowerExtension === ".jpeg")
  const targetPath = matches
    ? requestedPath
    : [".png", ".jpg", ".jpeg", ".webp"].includes(lowerExtension)
      ? requestedPath.slice(0, -requestedExtension.length) + extension
      : requestedPath + extension
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const savedPath = await pickNonOverwritePath(targetPath)
  await fs.writeFile(savedPath, bytes)
  const versioned = savedPath !== targetPath
  const formatName = format === "image/jpeg" ? "JPEG" : format === "image/webp" ? "WebP" : "PNG"
  const extensionNote =
    targetPath !== requestedPath
      ? ` The requested path ${requestedPath} was adjusted to ${targetPath} to match the ${formatName} bytes.`
      : ""
  const versionNote = versioned
    ? ` The target path ${targetPath} already existed; the new image was versioned to avoid overwriting it.`
    : ""
  return {
    savedPath,
    versioned,
    message: `Generated image saved to ${savedPath}. The image is ${formatName}, ${size.width}x${size.height} pixels.${extensionNote}${versionNote}`,
  }
}
