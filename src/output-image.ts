import type { FileHandle } from "node:fs/promises"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { formatMime, formatName, inspectImage, type OutputFormat, pathForFormat, RASTER_FORMATS } from "./image-format"
import type { SavedImage } from "./types"

const MAX_OUTPUT_VERSION_SUFFIX = 999
// The largest image attached inline: its base64 form stays below 4.9 MB, under the 5 MB image limit of chat models.
export const MAX_PREVIEW_BYTES = 3_670_016
const PREVIEW_FORMATS: readonly OutputFormat[] = RASTER_FORMATS

// What a call asked for beyond saving: an inline preview, and a transparent background whose result is checked.
export type SaveOptions = { preview?: boolean; expectTransparent?: boolean }

// Creates the first free name among `target` and its -v2 to -v999 variants. Each name is created exclusively, so an
// existing file, a file another writer creates first, or a symbolic link (followed or dangling) is never opened; only
// an existing name moves on to the next suffix, and any other failure stops.
async function claimPath(target: string): Promise<{ claimed: string; handle: FileHandle }> {
  const extension = path.extname(target)
  const stem = target.slice(0, target.length - extension.length)
  for (let version = 1; version <= MAX_OUTPUT_VERSION_SUFFIX; version++) {
    const claimed = version === 1 ? target : `${stem}-v${version}${extension}`
    try {
      return { claimed, handle: await fs.open(claimed, "wx") }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  throw new Error(
    `could not find a non-conflicting filename under ${stem}-vN${extension} (tried up to v${MAX_OUTPUT_VERSION_SUFFIX})`,
  )
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Writes the bytes to a file this call created. When the write or the close fails, removing that file is attempted:
// if the removal succeeds, the first failure propagates unchanged; if it fails, the error carries every failure and
// names the path, where a partial file may remain. A crash before the write ends can also leave a partial file.
async function writeClaimed(claimed: string, handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const failures: unknown[] = []
  await handle.writeFile(bytes).catch((error: unknown) => failures.push(error))
  await handle.close().catch((error: unknown) => failures.push(error))
  if (failures.length === 0) return
  try {
    await fs.unlink(claimed)
  } catch (cleanupError) {
    throw new AggregateError(
      [...failures, cleanupError],
      `could not write ${claimed}: ${reason(failures[0])}; removing it then failed (${reason(cleanupError)}), so a partial file may remain there`,
    )
  }
  throw failures[0]
}

// Resolves the output path (relative to ctxDir unless absolute), checks the bytes are one of the accepted formats with
// readable dimensions before creating anything, and saves them under the extension of the detected format without
// overwriting an existing file. Returns the user-facing message alongside the saved path, and the preview bytes when
// one was asked for and the format and size allow it; otherwise the message says why it was omitted.
export async function saveGeneratedImage(
  out: string,
  ctxDir: string,
  bytes: Uint8Array,
  accepted: readonly OutputFormat[],
  options: SaveOptions = {},
): Promise<SavedImage> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(ctxDir, out)
  const { format, description, opaquePng } = await inspectImage(bytes, accepted)
  const targetPath = pathForFormat(requestedPath, format, accepted)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const { claimed: savedPath, handle } = await claimPath(targetPath)
  await writeClaimed(savedPath, handle, bytes)
  const versioned = savedPath !== targetPath
  const extensionNote =
    targetPath !== requestedPath
      ? ` The requested path ${requestedPath} was adjusted to ${targetPath} to match the ${formatName(format)} bytes.`
      : ""
  const versionNote = versioned
    ? ` The target path ${targetPath} already existed; the new image was versioned to avoid overwriting it.`
    : ""
  const transparencyNote =
    options.expectTransparent && opaquePng
      ? ' Warning: background "transparent" was requested, but the saved PNG has no transparent pixels.'
      : ""
  let previewNote = ""
  let preview: SavedImage["preview"]
  if (options.preview) {
    if (!PREVIEW_FORMATS.includes(format)) {
      previewNote = ` Inline preview omitted: ${formatName(format)} cannot be attached inline; inspect the saved file at ${savedPath}.`
    } else if (bytes.length > MAX_PREVIEW_BYTES) {
      previewNote = ` Inline preview omitted: the image is ${bytes.length} bytes (limit ${MAX_PREVIEW_BYTES} bytes); use read on ${savedPath}.`
    } else {
      preview = { mime: formatMime(format), bytes }
    }
  }
  return {
    savedPath,
    versioned,
    message: `Generated image saved to ${savedPath}. The image is ${description}.${extensionNote}${versionNote}${transparencyNote}${previewNote}`,
    ...(preview ? { preview } : {}),
  }
}
