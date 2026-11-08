import type { z } from "zod"
import { acceptCredential, type CredentialFor, type CredentialSpec } from "./credential"
import { listFormatNames, type OutputFormat, RASTER_FORMATS } from "./image-format"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGEEDIT_TOOL, IMAGEGEN_TOOL, parseArgs, TOOL_OF } from "./schema"
import { SKILL_NAME } from "./skill"
import type { ImageTool, InfoTool, LookupTool, ReferenceRules, ToolSchema } from "./types"

// The sentences of an image tool's description that differ per backend; describeGenerationTool and describeEditTool
// assemble them with the guidance every Codex-style backend shares, so an agent sees the arguments, defaults and limits
// of the one backend that will run.
type ToolDescription = {
  subject: string
  requires: string
  controls: string
}

// `media` replaces the raster-only sentences for a backend that can also generate other formats.
export type GenerationDescription = ToolDescription & { media?: { what: string; medium: string; saves: string } }
// `references` says how many reference images the tool takes, and of which types.
export type EditDescription = ToolDescription & { references: string }

const RASTER_MEDIA = {
  what: "one raster image",
  medium:
    "Best for photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code.",
  saves: `Saves native ${listFormatNames(RASTER_FORMATS)} bytes and returns the actual absolute path, format and pixel dimensions. The extension is adjusted to match; use the returned out path for reads or subsequent edits. Size is a request, so check the dimensions when they matter.`,
}

export const SKILL_SENTENCE = `Load the ${SKILL_NAME} skill before image work when it is available, permitted and not already loaded; the tool also works without it.`
const SIZE_AND_BACKGROUND =
  "Choose size by the aspect ratio the use needs. For a cut-out, set background to transparent instead of asking in the prompt, and check the returned alpha."
export const VERSIONING =
  "An existing file at the output path is kept, even one a concurrent call created first, and the image gets the first free -vN suffix, up to -v999."

// The imagegen description of the Codex and OpenAI Images API backends.
export function describeGenerationTool({
  subject,
  requires,
  controls,
  media = RASTER_MEDIA,
}: GenerationDescription): string {
  return [
    `Generate ${media.what} from a text prompt through ${subject}. To change or combine existing images use ${IMAGEEDIT_TOOL} instead. ${SKILL_SENTENCE}`,
    requires,
    media.medium,
    SIZE_AND_BACKGROUND,
    media.saves,
    controls,
    VERSIONING,
  ].join(" ")
}

// The imageedit description of the Codex and OpenAI Images API backends.
export function describeEditTool({ subject, requires, controls, references }: EditDescription): string {
  return [
    `Edit or combine existing local images into one new raster image through ${subject}, guided by a prompt. To create an image from text alone use ${IMAGEGEN_TOOL}. ${SKILL_SENTENCE}`,
    requires,
    references,
    `Name each reference's role in the prompt (for example "Image 1: style; Image 2: layout") and what to keep. The result is a newly generated image, so areas the prompt does not mention can change; use an image editor when pixels must stay identical.`,
    SIZE_AND_BACKGROUND,
    RASTER_MEDIA.saves,
    controls,
    VERSIONING,
  ].join(" ")
}

type GenerationSchema = ToolSchema & z.ZodType<{ out: string }>
type EditSchema = ToolSchema & z.ZodType<{ out: string; images: string[] }>

// What a backend declares for one image tool. `schema` validates the complete input and `out` is the destination. The
// operation names the tool: generate is imagegen, edit is imageedit.
type ImageToolBase<S extends GenerationSchema, C extends CredentialSpec> = {
  description: string
  schema: S
  // The backend's credential; the flow checks the resolved one against it before any reference is read.
  credential: C
  // The formats the tool saves, the same list its `out` argument describes. Other provider types are refused.
  outputFormats: readonly OutputFormat[]
  // Text appended to the result message for this call, for example to separate requested from verified settings.
  resultNote?: (args: z.output<S>) => string | undefined
  // Appended to the error when the image was generated but could not be saved, for providers that bill generation.
  saveFailureNote?: string
}

// A tool that creates an image from text alone; it reads no reference image.
export type GenerationToolSpec<S extends GenerationSchema, C extends CredentialSpec> = ImageToolBase<S, C> & {
  operation: "generate"
  // Sends one request and returns the image bytes.
  request: (credential: CredentialFor<C>, args: z.output<S>, signal: AbortSignal) => Promise<Uint8Array>
}

// A tool that changes or combines the images its required `images` argument names, read in order as data URLs.
export type EditToolSpec<S extends EditSchema, C extends CredentialSpec> = ImageToolBase<S, C> & {
  operation: "edit"
  // What each reference of this call must satisfy, checked when the files are read.
  referenceRules: (args: z.output<S>) => ReferenceRules
  // Sends one request with the references and returns the image bytes.
  request: (
    credential: CredentialFor<C>,
    args: z.output<S>,
    references: string[],
    signal: AbortSignal,
  ) => Promise<Uint8Array>
}

// Parse and validate before the host is consulted, and authorize before any credential, reference image, or
// provider request is touched. The credential is checked before any reference is read. The signal is checked before
// starting and before saving; a request that is already in flight is cancelled through fetch. Nothing is retried, and
// a failing backend is not replaced by another.
export function defineImageTool<S extends GenerationSchema, C extends CredentialSpec>(
  spec: GenerationToolSpec<S, C>,
): ImageTool
export function defineImageTool<S extends EditSchema, C extends CredentialSpec>(spec: EditToolSpec<S, C>): ImageTool
export function defineImageTool(
  spec: GenerationToolSpec<EditSchema, CredentialSpec> | EditToolSpec<EditSchema, CredentialSpec>,
): ImageTool {
  const name = TOOL_OF[spec.operation]
  return {
    kind: "image",
    name,
    description: spec.description,
    schema: spec.schema,
    async run(rawArgs, host) {
      const args = parseArgs(spec.schema, rawArgs)
      host.signal.throwIfAborted()
      await host.authorize(name, { ...args })
      const directory = await host.resolveDirectory()
      const credential = acceptCredential(spec.credential, await host.resolveCredential())
      const image =
        spec.operation === "edit"
          ? await spec.request(
              credential,
              args,
              await readReferenceImages(args.images, directory, spec.referenceRules(args)),
              host.signal,
            )
          : await spec.request(credential, args, host.signal)
      host.signal.throwIfAborted()
      const saved = await saveGeneratedImage(args.out, directory, image, spec.outputFormats).catch((error: unknown) => {
        if (spec.saveFailureNote && error instanceof Error) {
          throw new Error(`${error.message} ${spec.saveFailureNote}`, { cause: error })
        }
        throw error
      })
      const note = spec.resultNote?.(args)
      return note ? { ...saved, message: `${saved.message} ${note}` } : saved
    },
  }
}

export type LookupToolSpec<S extends ToolSchema, C extends CredentialSpec> = {
  name: string
  description: string
  schema: S
  credential: C
  lookup: (credential: CredentialFor<C>, args: z.output<S>, signal: AbortSignal) => Promise<string>
}

// Parse and validate before the host is consulted, and authorize before the credential or the provider is touched.
// A lookup needs no session directory and touches no file. The signal is checked before starting and after the
// answer arrives; a request in flight is cancelled through fetch. Nothing is retried.
export function defineLookupTool<S extends ToolSchema, C extends CredentialSpec>(
  spec: LookupToolSpec<S, C>,
): LookupTool {
  return {
    kind: "lookup",
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    async run(rawArgs, host) {
      const args = parseArgs(spec.schema, rawArgs)
      host.signal.throwIfAborted()
      await host.authorize(spec.name, { ...args })
      const credential = acceptCredential(spec.credential, await host.resolveCredential())
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
