import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { type BodyRefusal, readBoundedResponseBody, safeUrlLabel, validateHttpsUrl } from "./http-download"
import { readImageDimensions } from "./image-format"
import { pngHasAlphaChannel } from "./png-alpha"
import type { ReferenceRules } from "./types"

// Where a call's reference entries come from: local paths resolve against `directory`, and each https URL is fetched
// only after `authorizeFetch` allows it. `signal` cancels downloads.
export type ReferenceSource = {
  directory: string
  authorizeFetch: (url: string) => Promise<void>
  signal: AbortSignal
}

// A call's inpainting mask entry and what the file must satisfy.
export type MaskEntry = { entry: string; rules: ReferenceRules }

// A reference as the request sends it, with the bytes it was encoded from for checks that need the pixels' header.
type LoadedReference = { dataUrl: string; bytes: Uint8Array }

// A URL download is capped here even when the backend allows larger files.
export const MAX_URL_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 3
const URL_TIMEOUT_MS = 30_000
// References are loaded at most this many at a time, so many large files or downloads do not all sit in memory at once.
const MAX_CONCURRENT_LOADS = 4

// An entry with a URL scheme of two or more characters is a URL, so a Windows drive path such as C:\image.png or
// C:image.png stays a local path. Every scheme other than https is then refused instead of being read as a missing
// local file.
const isUrl = (entry: string) => /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(entry)

// How a URL may appear in a message. A signed URL carries its token in the query, and a data: URL its whole payload,
// so neither is shown.
function urlLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:" ? safeUrlLabel(url) : `a ${url.protocol} URL`
  } catch {
    return "an unparsable URL"
  }
}

function describeRefusal(refusal: BodyRefusal, limit: number): string {
  switch (refusal.kind) {
    case "declared-too-large":
      return `it declares ${refusal.declared} bytes and the limit is ${limit}.`
    case "too-large":
      return `it is larger than the limit of ${limit} bytes.`
    case "empty":
      return "the response was empty."
    case "length-mismatch":
      return `${refusal.received} bytes arrived but the response declared ${refusal.declared}.`
  }
}

// Downloads one https reference without credentials, following at most MAX_REDIRECTS redirects by hand. Every hop is
// validated and authorized before it is fetched. All hops share one URL_TIMEOUT_MS network budget; time spent waiting
// for a permission answer is not counted. Messages name the URL without its query or fragment and never quote a
// response body or a runtime error, which can repeat the full URL.
async function download(raw: string, source: ReferenceSource, limit: number): Promise<Uint8Array> {
  const first = validateHttpsUrl(raw)
  if (!first.ok) {
    throw new Error(`reference image URL ${urlLabel(raw)} refused: ${first.reason} Use a local path or an https URL.`)
  }
  let url = first.url
  let remainingMs = URL_TIMEOUT_MS
  for (let hop = 0; ; hop++) {
    const fail = (reason: string) => new Error(`could not download reference image ${safeUrlLabel(url)}: ${reason}`)
    const timedOut = (step: string) => fail(`${step} failed or timed out after ${URL_TIMEOUT_MS / 1000} s.`)
    source.signal.throwIfAborted()
    await source.authorizeFetch(url.href)
    const started = performance.now()
    // AbortSignal.timeout takes whole milliseconds; Node rejects the fractions performance.now() leaves behind.
    const signal = AbortSignal.any([source.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)))])
    let res: Response
    try {
      res = await fetch(url, { method: "GET", redirect: "manual", signal })
    } catch {
      source.signal.throwIfAborted()
      throw timedOut("the request")
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      remainingMs -= performance.now() - started
      if (remainingMs <= 0) throw timedOut("the request")
      if (hop >= MAX_REDIRECTS) throw fail(`too many redirects (max ${MAX_REDIRECTS}).`)
      const location = res.headers.get("location")?.trim()
      if (!location) throw fail(`it answered HTTP ${res.status} without a Location header.`)
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw fail(`it answered HTTP ${res.status} with an invalid Location header.`)
      }
      const checked = validateHttpsUrl(next.href)
      if (!checked.ok) throw fail(`it redirected to ${urlLabel(next.href)}, which is refused: ${checked.reason}`)
      url = checked.url
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw fail(`HTTP ${res.status}.`)
    }
    let body: Awaited<ReturnType<typeof readBoundedResponseBody>>
    try {
      body = await readBoundedResponseBody(res, limit)
    } catch {
      source.signal.throwIfAborted()
      throw timedOut("reading the response")
    }
    if (!body.ok) throw fail(describeRefusal(body.refusal, limit))
    return body.bytes
  }
}

// Loads one reference entry, a local path or an https URL, and checks it against the backend's rules. A download stops
// at the largest file whose base64 encoding fits the backend's data URL length.
async function readReferenceImage(
  entry: string,
  source: ReferenceSource,
  rules: ReferenceRules,
): Promise<LoadedReference> {
  let label: string
  let bytes: Uint8Array
  if (isUrl(entry)) {
    label = urlLabel(entry)
    const encodable = rules.maxDataUrlLength ? Math.floor(rules.maxDataUrlLength / 4) * 3 : Number.POSITIVE_INFINITY
    bytes = await download(
      entry,
      source,
      Math.min(rules.maxBytes ?? Number.POSITIVE_INFINITY, encodable, MAX_URL_BYTES),
    )
  } else {
    label = path.isAbsolute(entry) ? entry : path.resolve(source.directory, entry)
    bytes = await fs.readFile(label)
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${label}`)
  }
  if (rules.mimeTypes && !rules.mimeTypes.includes(detected.mime)) {
    throw new Error(`unsupported reference image type ${detected.mime}: ${label}. Use ${rules.mimeTypes.join(", ")}.`)
  }
  if (rules.maxBytes && buf.length > rules.maxBytes) {
    throw new Error(`reference image is too large: ${label} is ${buf.length} bytes and the limit is ${rules.maxBytes}.`)
  }
  const dataUrl = `data:${detected.mime};base64,${buf.toString("base64")}`
  if (rules.maxDataUrlLength && dataUrl.length > rules.maxDataUrlLength) {
    throw new Error(
      `reference image is too large: ${label} encodes to ${dataUrl.length} characters and the limit is ${rules.maxDataUrlLength}.`,
    )
  }
  return { dataUrl, bytes: buf }
}

// An inpainting mask must be a PNG with an alpha channel and the pixel size of the image it applies to, after the
// image's EXIF orientation: orientations 5 to 8 swap width and height. Checked before any request, since the provider
// would bill or reject a mismatch.
function checkMask(mask: Uint8Array, image: Uint8Array): void {
  if (!pngHasAlphaChannel(mask)) {
    throw new Error("mask image must be a PNG with an alpha channel; transparent pixels mark the area to edit.")
  }
  const size = (bytes: Uint8Array) => {
    try {
      const { width, height, orientation = 1 } = readImageDimensions(bytes)
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
    } catch {
      return undefined
    }
  }
  const maskSize = size(mask)
  const imageSizeOf = size(image)
  if (!maskSize || !imageSizeOf) throw new Error("could not read the pixel dimensions of the mask or the first image.")
  if (maskSize.width !== imageSizeOf.width || maskSize.height !== imageSizeOf.height) {
    throw new Error(
      `mask is ${maskSize.width}x${maskSize.height} pixels but the first image is ${imageSizeOf.width}x${imageSizeOf.height}; they must match.`,
    )
  }
}

// Loads the reference entries in order and encodes them as data URLs, which the images edits endpoints accept as
// `images[].image_url`, then the mask when the call has one, checked against the first reference. The backend's rules
// reject a reference it cannot take before any request is sent. Downloads run concurrently, but the host is asked to
// allow one URL at a time. The first failure rejects the call and cancels the other downloads; no further entry,
// permission request or fetch starts after it.
export async function readReferenceImages(
  entries: readonly string[],
  source: ReferenceSource,
  rules: ReferenceRules = {},
  mask?: MaskEntry,
): Promise<{ references: string[]; mask?: string }> {
  const batch = new AbortController()
  const signal = AbortSignal.any([source.signal, batch.signal])
  let permissionQueue: Promise<void> = Promise.resolve()
  const batchSource: ReferenceSource = {
    directory: source.directory,
    signal,
    authorizeFetch: (url) => {
      const asked = permissionQueue.then(async () => {
        signal.throwIfAborted()
        try {
          await source.authorizeFetch(url)
        } catch (error) {
          // Abort before the queue advances, so no queued sibling URL is put to the host after a denial.
          batch.abort(error)
          throw error
        }
        signal.throwIfAborted()
      })
      permissionQueue = asked.catch(() => {})
      return asked
    },
  }
  const references: string[] = new Array(entries.length)
  // Only the first reference's bytes are kept, and only for the mask check.
  let firstImage: Uint8Array | undefined
  let next = 0
  const worker = async () => {
    while (!signal.aborted && next < entries.length) {
      const index = next++
      try {
        const loaded = await readReferenceImage(entries[index], batchSource, rules)
        references[index] = loaded.dataUrl
        if (mask && index === 0) firstImage = loaded.bytes
      } catch (error) {
        batch.abort(error)
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_LOADS, entries.length) }, worker))
  // A cancellation between two entries stops the workers without an error of their own.
  source.signal.throwIfAborted()
  if (!mask) return { references }
  if (!firstImage) throw new Error("a mask needs a first reference image to apply to.")
  const loadedMask = await readReferenceImage(mask.entry, source, mask.rules)
  checkMask(loadedMask.bytes, firstImage)
  return { references, mask: loadedMask.dataUrl }
}
