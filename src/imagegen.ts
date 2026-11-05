import type { z } from "zod"
import { readReferenceImages } from "./input-image"
import { type OutputFormat, saveGeneratedImage } from "./output-image"
import { parseArgs } from "./schema"
import { SKILL_NAME } from "./skill"
import type { ImageCredential, ImageTool, InfoTool, LookupTool, ReferenceRules, ToolSchema } from "./types"

export const IMAGEGEN_TOOL = "imagegen"
// The model information tool of a backend that offers one: a local table on NanoGPT, a live provider list on the
// OpenAI Images API.
export const MODELS_TOOL = "imagegen_models"

// The sentences of the `imagegen` description that differ per backend; describeImagegen assembles them with the
// shared guidance. `media` replaces the raster-only sentences for a backend that can also save other formats.
export type ImagegenDescription = {
  subject: string
  requires: string
  controls: string
  media?: { what: string; medium: string; saves: string }
}

const RASTER_MEDIA = {
  what: "one raster image",
  medium:
    "Best for photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code.",
  saves:
    "Saves native PNG, JPEG or WebP bytes and returns the actual absolute path, format and pixel dimensions. The extension is adjusted to match; use the returned out path for reads or subsequent edits. Size is a request, so check the dimensions when they matter.",
}

// The `imagegen` description of the Codex and OpenAI Images API backends: guidance shared by both around the
// sentences the backend supplies, so an agent sees the arguments, defaults and limits of the one backend that will run.
export function describeImagegen({ subject, requires, controls, media = RASTER_MEDIA }: ImagegenDescription): string {
  return [
    `Generate or edit ${media.what} through ${subject}. Load the ${SKILL_NAME} skill before image work when it is available, permitted and not already loaded; the tool also works without it.`,
    requires,
    media.medium,
    `With images, name each reference's role in the prompt (for example "Image 1: style; Image 2: layout") and what to keep. The result is a newly generated image, so areas the prompt does not mention can change; use an image editor when pixels must stay identical.`,
    "Choose size by the aspect ratio the use needs. For a cut-out, set background to transparent instead of asking in the prompt, and check the returned alpha.",
    media.saves,
    controls,
    "Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
  ].join(" ")
}

// What a backend declares for one image tool. `schema` validates the complete input and `out` is the destination.
export type ImageToolSpec<S extends ToolSchema & z.ZodType<{ out: string }>> = {
  name: string
  description: string
  schema: S
  // The reference image paths of a call and the rules each file must satisfy.
  references: (args: z.output<S>) => { paths: readonly string[] | null | undefined; rules: ReferenceRules }
  // Returns the generated image as base64. The credential is one of the kind the backend declares.
  generate: (
    credential: ImageCredential,
    args: z.output<S>,
    referenceDataUrls: string[],
    signal: AbortSignal,
  ) => Promise<string>
  // Text appended to the result message for this call, for example to separate requested from verified settings.
  resultNote?: (args: z.output<S>) => string | undefined
  // Appended to the error when the image was generated but could not be saved, for providers that bill generation.
  saveFailureNote?: string
  // The formats the tool saves. Omitted, PNG, JPEG and WebP; other provider types are refused.
  outputFormats?: readonly OutputFormat[]
}

// Parse and validate before the host is consulted, and authorize before any credential, reference image, or
// provider request is touched. The signal is checked before starting and before saving; a request that is already in
// flight is cancelled through fetch. Nothing is retried, and a failing backend is not replaced by another.
export function defineImageTool<S extends ToolSchema & z.ZodType<{ out: string }>>(spec: ImageToolSpec<S>): ImageTool {
  return {
    kind: "image",
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    async run(rawArgs, host) {
      const args = parseArgs(spec.schema, rawArgs)
      host.signal.throwIfAborted()
      await host.authorize(spec.name, { ...args })
      const directory = await host.resolveDirectory()
      const credential = await host.resolveCredential()
      const { paths, rules } = spec.references(args)
      const referenceDataUrls = await readReferenceImages(paths, directory, rules)
      const base64 = await spec.generate(credential, args, referenceDataUrls, host.signal)
      host.signal.throwIfAborted()
      const saved = await saveGeneratedImage(args.out, directory, base64, spec.outputFormats).catch(
        (error: unknown) => {
          if (spec.saveFailureNote && error instanceof Error) {
            throw new Error(`${error.message} ${spec.saveFailureNote}`, { cause: error })
          }
          throw error
        },
      )
      const note = spec.resultNote?.(args)
      return note ? { ...saved, message: `${saved.message} ${note}` } : saved
    },
  }
}

export type LookupToolSpec<S extends ToolSchema> = {
  name: string
  description: string
  schema: S
  // Asks the provider and returns the answer text. The credential is one of the kind the backend declares.
  lookup: (credential: ImageCredential, args: z.output<S>, signal: AbortSignal) => Promise<string>
}

// Parse and validate before the host is consulted, and authorize before the credential or the provider is touched.
// A lookup needs no session directory and touches no file. The signal is checked before starting and after the
// answer arrives; a request in flight is cancelled through fetch. Nothing is retried.
export function defineLookupTool<S extends ToolSchema>(spec: LookupToolSpec<S>): LookupTool {
  return {
    kind: "lookup",
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    async run(rawArgs, host) {
      const args = parseArgs(spec.schema, rawArgs)
      host.signal.throwIfAborted()
      await host.authorize(spec.name, { ...args })
      const credential = await host.resolveCredential()
      const answer = await spec.lookup(credential, args, host.signal)
      host.signal.throwIfAborted()
      return answer
    },
  }
}

export type InfoToolSpec<S extends ToolSchema> = {
  name: string
  description: string
  schema: S
  answer: (args: z.output<S>) => string
}

// An information tool parses its arguments and answers from data in this package.
export function defineInfoTool<S extends ToolSchema>(spec: InfoToolSpec<S>): InfoTool {
  return {
    kind: "info",
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    run: (rawArgs) => spec.answer(parseArgs(spec.schema, rawArgs)),
  }
}
