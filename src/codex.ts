import { z } from "zod"
import type { CredentialSpec, OAuthCredential } from "./credential"
import { RASTER_FORMATS } from "./image-format"
import {
  defineImageTool,
  describeEditTool,
  describeGenerationTool,
  type EditToolSpec,
  type GenerationToolSpec,
} from "./imagegen"
import { postImagesRequest } from "./images-request"
import {
  type ArgsSpec,
  editShape,
  GENERATION_MOVED_ARGUMENTS,
  generationShape,
  IMAGEEDIT_TOOL,
  IMAGEGEN_TOOL,
  strictArgs,
} from "./schema"
import { appendSizeToPrompt, IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"
import type { Backend } from "./types"

// Codex OAuth images endpoint URLs: generations for imagegen, edits for imageedit.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/model-provider-info/src/lib.rs#L80
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/codex-api/src/endpoint/images.rs#L62-L83
const CODEX_IMAGES_GENERATIONS_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
const CODEX_IMAGES_EDITS_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits"

// Same fixed fields as Codex. They describe the request; the plugin does not verify the model or quality tier
// that produced the image. The size is requested through the prompt (see appendSizeToPrompt). The model and quality
// arguments replace the first two when given.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L414-L440
const CODEX_REQUEST_DEFAULTS = { model: "gpt-image-2", quality: "auto", size: "auto" }

// Same limit as Codex (MAX_EDIT_IMAGES).
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L59
const MAX_REFERENCE_IMAGES = 5

// Both tools save the raster formats the endpoints return.
const OUTPUT_FORMATS = RASTER_FORMATS

const codexCredential = {
  type: "oauth",
  provider: "openai",
  label: "OpenAI ChatGPT OAuth",
} as const satisfies CredentialSpec

const shared: ArgsSpec = {
  size: z
    .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]], {
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use one of: ${SIZE_CHOICES}.`
          : `Unsupported size "${issue.input}". Use one of: ${SIZE_CHOICES}.`,
    })
    .describe(
      "Requested width x height preset; choose it by aspect ratio. The tool asks for it in the prompt and does not resize the result; the result reports the actual pixel dimensions.",
    ),
  outputFormats: OUTPUT_FORMATS,
  model: `Optional model name, sent to the Codex backend unchanged. Omit it to send ${CODEX_REQUEST_DEFAULTS.model}. Whether the backend applies it is unverified in recorded runs and can change, so the result text lists it as requested, not verified.`,
  quality: `Optional quality value, sent to the Codex backend unchanged. Omit it to send ${CODEX_REQUEST_DEFAULTS.quality}. Whether the backend applies it is unverified in recorded runs and can change, so the result text lists it as requested, not verified.`,
}

const generateSchema = strictArgs(IMAGEGEN_TOOL, generationShape(shared), GENERATION_MOVED_ARGUMENTS)
const editSchema = strictArgs(IMAGEEDIT_TOOL, editShape({ ...shared, maxImages: MAX_REFERENCE_IMAGES }))

export type CodexArgs = z.output<typeof generateSchema>

// One request to the endpoint of the invoked tool. `extra` holds the fields only that tool sends.
async function request(
  url: string,
  auth: OAuthCredential,
  args: CodexArgs,
  signal: AbortSignal,
  extra: Record<string, unknown> = {},
): Promise<Uint8Array> {
  return postImagesRequest({
    label: "codex",
    url,
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
    },
    body: {
      prompt: appendSizeToPrompt(args.prompt, args.size),
      ...CODEX_REQUEST_DEFAULTS,
      ...(args.model ? { model: args.model } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
      background: args.background ?? "opaque",
      ...extra,
    },
    signal,
    secret: auth.access,
  })
}

function resultNote(args: CodexArgs) {
  const requested = [args.model && `model ${args.model}`, args.quality && `quality ${args.quality}`].filter(Boolean)
  if (requested.length === 0) return undefined
  return `Requested ${requested.join(" and ")}; the Codex response does not report which settings it applied, so they are unverified.`
}

const SUBJECT = "the ChatGPT Codex image backend"
const REQUIRES = "Requires OpenCode ChatGPT OAuth authentication."
const CONTROLS =
  "Optional model and quality are sent unchanged, but whether this backend applies them is unverified and can change; when you set either, the result text separates what was requested from what is verified. There are no image-count or output-format controls."

export const codexImagegen = {
  operation: "generate",
  description: describeGenerationTool({
    subject: SUBJECT,
    requires: `${REQUIRES} The prompt is sent to the provider.`,
    controls: CONTROLS,
  }),
  schema: generateSchema,
  credential: codexCredential,
  outputFormats: OUTPUT_FORMATS,
  request: (credential, args, signal) => request(CODEX_IMAGES_GENERATIONS_ENDPOINT, credential, args, signal),
  resultNote,
} satisfies GenerationToolSpec<typeof generateSchema, typeof codexCredential>

export const codexImageedit = {
  operation: "edit",
  description: describeEditTool({
    subject: SUBJECT,
    requires: `${REQUIRES} The prompt and reference images are sent to the provider.`,
    references: `Required images: 1 to ${MAX_REFERENCE_IMAGES} local reference image paths.`,
    controls: CONTROLS,
  }),
  schema: editSchema,
  credential: codexCredential,
  outputFormats: OUTPUT_FORMATS,
  // No reference type or size rule is known for Codex: every file detected as an image is sent, and the endpoint
  // decides whether it takes it.
  referenceRules: () => ({}),
  request: (credential, args, references, signal) =>
    request(CODEX_IMAGES_EDITS_ENDPOINT, credential, args, signal, {
      images: references.map((dataUrl) => ({ image_url: dataUrl })),
    }),
  resultNote,
} satisfies EditToolSpec<typeof editSchema, typeof codexCredential>

export const codexBackend = {
  id: "codex",
  credential: codexCredential,
  tools: [defineImageTool(codexImagegen), defineImageTool(codexImageedit)],
} satisfies Backend
