import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { ReferenceRules } from "./types"

async function readImageAsDataUrl(filePath: string, ctxDir: string, rules: ReferenceRules): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  const buf = await fs.readFile(abs)
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${abs}`)
  }
  if (rules.mimeTypes && !rules.mimeTypes.includes(detected.mime)) {
    throw new Error(`unsupported reference image type ${detected.mime}: ${abs}. Use ${rules.mimeTypes.join(", ")}.`)
  }
  if (rules.maxBytes && buf.length > rules.maxBytes) {
    throw new Error(`reference image is too large: ${abs} is ${buf.length} bytes and the limit is ${rules.maxBytes}.`)
  }
  const dataUrl = `data:${detected.mime};base64,${buf.toString("base64")}`
  if (rules.maxDataUrlLength && dataUrl.length > rules.maxDataUrlLength) {
    throw new Error(
      `reference image is too large: ${abs} encodes to ${dataUrl.length} characters and the limit is ${rules.maxDataUrlLength}.`,
    )
  }
  return dataUrl
}

// Read the optional reference image paths and encode them as data URLs, which the images edits endpoints accept as
// `images[].image_url`. Paths resolve relative to the OpenCode context directory unless absolute. The backend's rules
// reject a reference it cannot take before any request is sent.
export async function readReferenceImages(
  paths: readonly string[] | null | undefined,
  ctxDir: string,
  rules: ReferenceRules = {},
): Promise<string[]> {
  return Promise.all((paths ?? []).map((p) => readImageAsDataUrl(p, ctxDir, rules)))
}
