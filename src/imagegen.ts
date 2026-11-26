import type { z } from "zod"
import { acceptCredential, type CredentialFor, type CredentialSpec } from "./credential"
import type { OutputFormat } from "./image-format"
import { type MaskEntry, readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGEEDIT_TOOL, IMAGEGEN_TOOL, parseArgs, TOOL_OF } from "./schema"
import { SKILL_NAME } from "./skill"
import type { ImageTool, InfoTool, LookupTool, ReferenceRules, ToolSchema } from "./types"

// The parts of an image tool's description that differ per backend. describeGenerationTool and describeEditTool put
// the routing, skill, discovery, credential and critical rules first: an OpenCode 2 Code Mode catalog can show only the
// first 497 characters of a description (OpenCode 2.3.2 cuts a longer one there and adds "..."), while argument
// descriptions always appear in full. Argument mechanics (sizes, formats, limits, versioning) therefore live in the
// argument descriptions. An agent that never loads the skill still needs the complete contract from the description
// and its arguments.
export type ToolDescription = {
  // Who runs the request, for example "the OpenAI Images API".
  subject: string
  // The model discovery step, for a backend with a model tool.
  discovery?: string
  // The credential the tool needs and who receives the prompt and references.
  requires: string
  // The backend's most important rule beyond routing and credentials.
  critical?: string
  // Further guidance, after the lead.
  details: string[]
}

// `what` replaces "one raster image" for a backend that can also generate other formats.
export type GenerationDescription = ToolDescription & { what?: string }

export const RASTER_MEDIUM =
  "Raster output suits photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code."
const SKILL_SENTENCE = `Load the ${SKILL_NAME} skill first if available and permitted.`
const RESULT_PATH = "Use the returned out path for reads or edits."
const GENERATIVE_EDIT = "Unmentioned areas can change; pixel-exact edits need an image editor."

const assemble = (parts: Array<string | undefined>) => parts.filter(Boolean).join(" ")

export function describeGenerationTool({
  subject,
  what = "one raster image",
  discovery,
  requires,
  critical,
  details,
}: GenerationDescription): string {
  return assemble([
    `Generate ${what} from a text prompt via ${subject}; to edit or combine images, use ${IMAGEEDIT_TOOL}.`,
    SKILL_SENTENCE,
    discovery,
    requires,
    critical,
    RESULT_PATH,
    ...details,
  ])
}

export function describeEditTool({ subject, discovery, requires, critical, details }: ToolDescription): string {
  return assemble([
    `Edit or combine images into one new raster image via ${subject}; for text only, use ${IMAGEGEN_TOOL}.`,
    SKILL_SENTENCE,
    discovery,
    requires,
    GENERATIVE_EDIT,
    critical,
    RESULT_PATH,
    ...details,
  ])
}

// `preview` and `background` are read by the shared flow when a tool defines them.
type GenerationSchema = ToolSchema & z.ZodType<{ out: string; preview?: boolean | null; background?: string | null }>
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
  // For a tool with an inpainting mask: the call's mask entry, if any, and what the file must satisfy. The flow loads
  // it like a reference and checks it is a PNG with alpha and the pixel size of the first image.
  mask?: (args: z.output<S>) => MaskEntry | undefined
  // Sends one request with the references, and the mask data URL when the call has one, and returns the image bytes.
  request: (
    credential: CredentialFor<C>,
    args: z.output<S>,
    references: string[],
    signal: AbortSignal,
    mask?: string,
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
      let image: Uint8Array
      if (spec.operation === "edit") {
        const source = { directory, authorizeFetch: host.authorizeFetch, signal: host.signal }
        const { references, mask } = await readReferenceImages(
          args.images,
          source,
          spec.referenceRules(args),
          spec.mask?.(args),
        )
        image = await spec.request(credential, args, references, host.signal, mask)
      } else {
        image = await spec.request(credential, args, host.signal)
      }
      host.signal.throwIfAborted()
      const options = { preview: args.preview === true, expectTransparent: args.background === "transparent" }
      const saved = await saveGeneratedImage(args.out, directory, image, spec.outputFormats, options).catch(
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
