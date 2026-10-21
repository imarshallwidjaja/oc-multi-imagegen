import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { type GenerateArgs, parseArgs } from "./schema"
import { SKILL_NAME } from "./skill"
import type { Backend, ImageCredential } from "./types"

export const IMAGEGEN_TOOL = "imagegen"

// The tool description for the active backend: guidance shared by every backend around the sentences the backend
// supplies, so an agent sees the arguments, defaults and limits of the one backend that will run.
export function describeImagegen(backend: Backend): string {
  const { subject, requires, controls } = backend.description
  return [
    `Generate or edit one raster image through ${subject}. Load the ${SKILL_NAME} skill before image work when it is available, permitted and not already loaded; the tool also works without it.`,
    requires,
    "Best for photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code.",
    `With images, name each reference's role in the prompt (for example "Image 1: style; Image 2: layout") and what to keep. The result is a newly generated image, so areas the prompt does not mention can change; use an image editor when pixels must stay identical.`,
    "Choose size by the aspect ratio the use needs. For a cut-out, set background to transparent instead of asking in the prompt, and check the returned alpha.",
    "Returns the saved PNG's absolute path and actual pixel dimensions; size is a request, so check the dimensions when they matter.",
    controls,
    "Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
  ].join(" ")
}

// What a host adapter supplies for one tool call. generateImage invokes these in order:
// authorize, resolveDirectory, resolveCredential.
export type ImagegenHost = {
  signal: AbortSignal
  // Asks the host to allow the whole imagegen operation. Rejects when the host denies it.
  authorize: (args: GenerateArgs) => Promise<void>
  resolveDirectory: () => Promise<string>
  // Returns the credential kind the active backend declares.
  resolveCredential: () => Promise<ImageCredential>
}

// Parse and validate before the host is consulted, and authorize before any credential, reference
// image, or provider request is touched. The signal is checked before starting and before saving;
// a request that is already in flight is cancelled through fetch. Nothing is retried, and a failing
// backend is not replaced by another.
export async function generateImage(rawArgs: unknown, backend: Backend, host: ImagegenHost) {
  const args = parseArgs(backend.argsSchema, rawArgs)
  host.signal.throwIfAborted()
  await host.authorize(args)
  const directory = await host.resolveDirectory()
  const credential = await host.resolveCredential()
  const referenceDataUrls = await readReferenceImages(args.images, directory, backend.references)
  const base64 = await backend.generate(credential, args, referenceDataUrls, host.signal)
  host.signal.throwIfAborted()
  const saved = await saveGeneratedImage(args.out, directory, base64)
  const note = backend.resultNote?.(args)
  return note ? { ...saved, message: `${saved.message} ${note}` } : saved
}
