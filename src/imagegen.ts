import { callViaCodexImages } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { type GenerateArgs, parseArgs } from "./schema"
import { SKILL_NAME } from "./skill"
import type { OpenAIAuth } from "./types"

export const IMAGEGEN_TOOL = "imagegen"

export const IMAGEGEN_DESCRIPTION = [
  `Generate or edit one raster image through the ChatGPT Codex image backend. Load the ${SKILL_NAME} skill before image work when it is available, permitted and not already loaded; the tool also works without it.`,
  "Requires OpenCode ChatGPT OAuth authentication. The prompt and any reference images are sent to the provider.",
  "Best for photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code.",
  `With images, name each reference's role in the prompt (for example "Image 1: style; Image 2: layout") and what to keep. The result is a newly generated image, so areas the prompt does not mention can change; use an image editor when pixels must stay identical.`,
  "Choose size by the aspect ratio the use needs. For a cut-out, set background to transparent instead of asking in the prompt, and check the returned alpha.",
  "Returns the saved PNG's absolute path and actual pixel dimensions; size is a request, so check the dimensions when they matter.",
  "The tool has no model, quality, image-count or output-format controls, and other arguments are not sent to the provider.",
  "Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
].join(" ")

// What a host adapter supplies for one tool call. generateImage invokes these in order:
// authorize, resolveDirectory, resolveAuth.
export type ImagegenHost = {
  signal: AbortSignal
  // Asks the host to allow the whole imagegen operation. Rejects when the host denies it.
  authorize: (args: GenerateArgs) => Promise<void>
  resolveDirectory: () => Promise<string>
  resolveAuth: () => Promise<OpenAIAuth>
}

// Parse and validate before the host is consulted, and authorize before any credential, reference
// image, or provider request is touched. The signal is checked before starting and before saving;
// a request that is already in flight is cancelled through fetch. Nothing is retried.
export async function generateImage(rawArgs: unknown, host: ImagegenHost) {
  const args = parseArgs(rawArgs)
  host.signal.throwIfAborted()
  await host.authorize(args)
  const directory = await host.resolveDirectory()
  const auth = await host.resolveAuth()
  const inputImageDataUrls = await readReferenceImages(args.images, directory)
  const base64 = await callViaCodexImages(auth, args, inputImageDataUrls, host.signal)
  host.signal.throwIfAborted()
  return saveGeneratedImage(args.out, directory, base64)
}
