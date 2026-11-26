import { z } from "zod"
import type { CredentialSpec, KeyCredential } from "./credential"
import { listFormatNames, type OutputFormat, RASTER_FORMATS } from "./image-format"
import {
  defineImageTool,
  defineLookupTool,
  describeEditTool,
  describeGenerationTool,
  type EditToolSpec,
  type GenerationToolSpec,
} from "./imagegen"
import { postImagesRequest } from "./images-request"
import { lookUpOpenAiModels, openaiModelsSchema } from "./openai-models"
import {
  type ArgsSpec,
  editShape,
  GENERATION_MOVED_ARGUMENTS,
  generationShape,
  IMAGEEDIT_TOOL,
  IMAGEGEN_TOOL,
  MODELS_TOOL,
  strictArgs,
} from "./schema"
import type { Backend } from "./types"

// Official OpenAI Images API: generations for imagegen, edits for imageedit. The documented JSON body for edits takes
// references as images[].image_url data URLs.
// https://developers.openai.com/api/reference/resources/images/methods/generate
// https://developers.openai.com/api/reference/resources/images/methods/edit
const GENERATIONS_ENDPOINT = "https://api.openai.com/v1/images/generations"
const EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits"

// https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
const DEFAULT_MODEL = "gpt-image-2.6-sunburst"
const DEFAULT_QUALITY = "auto"

// The documented output formats, each requested with output_format and saved as returned. GIF and SVG come from the
// generations endpoint only, so imageedit saves the raster formats alone, and only the raster formats keep the opaque
// background default. A transparent background needs PNG or WebP.
// https://developers.openai.com/api/docs/guides/image-generation#generate-svg-output
// https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output
const EDIT_OUTPUT_FORMATS = RASTER_FORMATS
const GENERATION_ONLY_FORMATS = ["gif", "svg"] as const satisfies readonly OutputFormat[]
const OUTPUT_FORMATS = [...EDIT_OUTPUT_FORMATS, ...GENERATION_ONLY_FORMATS] as const
const DEFAULT_OUTPUT_FORMAT = "png"
const TRANSPARENT_FORMATS: readonly OutputFormat[] = ["png", "webp"]
const generationOnlyFormats: readonly string[] = GENERATION_ONLY_FORMATS
const isGenerationOnly = (format: string) => generationOnlyFormats.includes(format)

// "png (default), jpeg or webp": the output_format values, as an agent passes them.
function outputFormatValues(formats: readonly OutputFormat[]): string {
  const values = formats.map((format) => (format === DEFAULT_OUTPUT_FORMAT ? `${format} (default)` : format))
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`
}

// GIF frame controls. The guide documents 2 to 64 frames and the API reference 2 to 16; the reference caps the encoded
// delay far above the guide's 2000 ms. These are the tool's limits, the range both sources share, not proven provider
// maxima.
const FRAME_COUNT = { min: 2, max: 16 }
const FRAME_DURATION_MS = { min: 20, max: 2000 }

// Documented reference limits: up to 16 images, and an image_url of at most 20971520 characters.
const MAX_REFERENCE_IMAGES = 16
const MAX_DATA_URL_LENGTH = 20971520
const REFERENCE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

// The documented size syntax: WIDTHxHEIGHT, both multiples of 16, aspect ratio between 1:3 and 3:1. Pixel and edge
// limits depend on the model and are left to the API to enforce.
const SIZE_PATTERN = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/
const SIZE_RULE = "WIDTHxHEIGHT in pixels, each a multiple of 16, with an aspect ratio between 1:3 and 3:1"

function sizeProblem(size: string): string | undefined {
  const match = SIZE_PATTERN.exec(size)
  if (!match) return `Use ${SIZE_RULE}, for example 1536x864.`
  const [width, height] = [Number(match[1]), Number(match[2])]
  if (width % 16 !== 0 || height % 16 !== 0) return `Width and height must each be a multiple of 16 (${SIZE_RULE}).`
  if (width > height * 3 || height > width * 3) return `The aspect ratio must be between 1:3 and 3:1 (${SIZE_RULE}).`
  return undefined
}

function sizeField(note = "") {
  return z
    .string({
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use ${SIZE_RULE}, for example 1536x864.`
          : `Unsupported size ${JSON.stringify(issue.input)}. Use ${SIZE_RULE}, for example 1536x864.`,
    })
    .superRefine((size, ctx) => {
      const problem = sizeProblem(size)
      if (problem) ctx.addIssue({ code: "custom", message: `Unsupported size "${size}". ${problem}` })
    })
    .describe(
      `Requested image size as ${SIZE_RULE}, for example 1536x864. It is sent to the API unchanged; choose it by aspect ratio. Larger sizes cost more, resolutions above 2560x1440 are experimental, and the API rejects sizes the model does not support. Check the returned dimensions when they matter.${note}`,
    )
}

const MODEL = `Optional model name, sent to the API unchanged. Defaults to ${DEFAULT_MODEL}; ${MODELS_TOOL} lists the image models this key can use.`
const QUALITY = `Optional quality value, sent to the API unchanged. Defaults to ${DEFAULT_QUALITY}.`

const generationArgs: ArgsSpec = {
  size: sizeField(" For gif it is the size of each frame."),
  outputFormats: OUTPUT_FORMATS,
  background:
    "Optional background. For png, jpeg and webp it defaults to opaque, and transparent needs output_format png or webp; use it for a cut-out instead of asking for one in the prompt. For gif and svg it is sent only when set, and only opaque is accepted. The returned alpha can be soft, and the tool does not check or clean it up.",
  model: MODEL,
  quality: `${QUALITY} For svg it controls the generated reference image.`,
}

const editArgs: ArgsSpec = {
  size: sizeField(),
  outputFormats: EDIT_OUTPUT_FORMATS,
  background:
    "Optional background; defaults to opaque, and transparent needs output_format png or webp. Use it for a cut-out instead of asking for one in the prompt. The returned alpha can be soft, and the tool does not check or clean it up.",
  model: MODEL,
  quality: QUALITY,
}

type Issue = (path: string, message: string) => void
const issuer =
  (ctx: z.RefinementCtx): Issue =>
  (path, message) =>
    ctx.addIssue({ code: "custom", path: [path], message })

function checkBackground(args: { background?: string | null }, format: OutputFormat, issue: Issue) {
  if (args.background === "transparent" && !TRANSPARENT_FORMATS.includes(format)) {
    issue("background", `A transparent background needs output_format png or webp, not ${format}.`)
  }
}

const generateSchema = strictArgs(
  IMAGEGEN_TOOL,
  {
    ...generationShape(generationArgs),
    output_format: z
      .enum(OUTPUT_FORMATS)
      .nullish()
      .describe(
        `Optional output format: ${outputFormatValues(OUTPUT_FORMATS)}. gif is an animated GIF and svg a static vector document authored from a generated reference image. The bytes are saved as returned.`,
      ),
    frame_count: z
      .number()
      .int()
      .min(FRAME_COUNT.min)
      .max(FRAME_COUNT.max)
      .nullish()
      .describe(
        `Optional number of GIF frames, ${FRAME_COUNT.min} to ${FRAME_COUNT.max}; only with output_format gif. Omitted, the API chooses (documented default 9). This is the tool's limit, not a proven provider maximum. All frames must fit the model's pixel budget: if the API rejects the request, use a smaller size or fewer frames.`,
      ),
    frame_duration_ms: z
      .number()
      .int()
      .min(FRAME_DURATION_MS.min)
      .max(FRAME_DURATION_MS.max)
      .nullish()
      .describe(
        `Optional delay per GIF frame in milliseconds, ${FRAME_DURATION_MS.min} to ${FRAME_DURATION_MS.max}, rounded by the API to 10 ms; only with output_format gif. Omitted, the API chooses (documented default 200). This is the tool's limit, not a proven provider maximum.`,
      ),
    svg_model: z
      .string()
      .min(1)
      .nullish()
      .describe(
        `Optional model that authors the SVG, sent as svg.model; only with output_format svg. Accounts with SVG author selection need it and others must omit it. Set it only when the operator names one or the API asks for it; never guess one. ${MODELS_TOOL} with query lists candidate IDs, which are not proof of SVG support.`,
      ),
  },
  GENERATION_MOVED_ARGUMENTS,
).superRefine((args, ctx) => {
  const format = args.output_format ?? DEFAULT_OUTPUT_FORMAT
  const issue = issuer(ctx)
  if (args.frame_count != null && format !== "gif") {
    issue("frame_count", "frame_count is only used with output_format gif.")
  }
  if (args.frame_duration_ms != null && format !== "gif") {
    issue("frame_duration_ms", "frame_duration_ms is only used with output_format gif.")
  }
  if (args.svg_model != null && format !== "svg") issue("svg_model", "svg_model is only used with output_format svg.")
  checkBackground(args, format, issue)
})

// GIF and SVG come only from the generations endpoint, so the edit tool refuses their controls instead of dropping them.
const GENERATION_ONLY = `GIF and SVG output come only from ${IMAGEGEN_TOOL} without reference images; ${IMAGEEDIT_TOOL} saves ${listFormatNames(EDIT_OUTPUT_FORMATS)}.`
const EDIT_MOVED_ARGUMENTS = {
  frame_count: GENERATION_ONLY,
  frame_duration_ms: GENERATION_ONLY,
  svg_model: GENERATION_ONLY,
}

const editSchema = strictArgs(
  IMAGEEDIT_TOOL,
  {
    ...editShape({
      ...editArgs,
      maxImages: MAX_REFERENCE_IMAGES,
      imagesNote: "Each file must be PNG, JPEG or WebP.",
    }),
    output_format: z
      .enum(EDIT_OUTPUT_FORMATS, {
        error: (issue) =>
          typeof issue.input === "string" && isGenerationOnly(issue.input)
            ? `output_format ${issue.input} is generation-only: the OpenAI edits endpoint does not return it. ${GENERATION_ONLY}`
            : undefined,
      })
      .nullish()
      .describe(`Optional output format: ${outputFormatValues(EDIT_OUTPUT_FORMATS)}. The bytes are saved as returned.`),
  },
  EDIT_MOVED_ARGUMENTS,
).superRefine((args, ctx) => checkBackground(args, args.output_format ?? DEFAULT_OUTPUT_FORMAT, issuer(ctx)))

type GenerateArgs = z.output<typeof generateSchema>
type EditArgs = z.output<typeof editSchema>

const openaiApiCredential = {
  type: "key",
  provider: "openai-images",
  label: "OpenAI Images API",
  environmentVariable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
} as const satisfies CredentialSpec

// The fields both endpoints take. The raster formats keep the opaque background default; GIF and SVG send a background
// only when the caller sets one.
function sharedBody(args: GenerateArgs | EditArgs) {
  const format = args.output_format ?? DEFAULT_OUTPUT_FORMAT
  const background = args.background ?? (isGenerationOnly(format) ? undefined : "opaque")
  return {
    model: args.model ?? DEFAULT_MODEL,
    prompt: args.prompt,
    size: args.size,
    quality: args.quality ?? DEFAULT_QUALITY,
    ...(background ? { background } : {}),
    n: 1,
    output_format: format,
    stream: false,
  }
}

// Sends one request to the endpoint of the invoked tool.
async function post(url: string, { key }: KeyCredential, body: Record<string, unknown>, signal: AbortSignal) {
  return postImagesRequest({
    label: "openai-api",
    url,
    headers: { Authorization: `Bearer ${key}` },
    body,
    signal,
    secret: key,
  })
}

const KEY_SOURCE = `${openaiApiCredential.environmentVariable} in the OpenCode process environment, else the saved ${openaiApiCredential.provider} credential`
const REQUIRES = `Requires an OpenAI Images API key: ${KEY_SOURCE}.`
const DISCOVERY = `Call ${MODELS_TOOL} first.`
const KEY_DETAIL = `The key is ${KEY_SOURCE}.`
const SIZE_IS_REQUESTED = "Size is a request, so check the returned dimensions when they matter."
const ONE_IMAGE = "Each call makes one image."
const NO_REPEAT = "Do not repeat a rejected call unchanged."

export const openaiApiImagegen = {
  operation: "generate",
  description: describeGenerationTool({
    subject: "the OpenAI Images API",
    what: "one image (raster, animated GIF or static SVG)",
    discovery: DISCOVERY,
    requires: "Needs an OpenAI Images API key; the prompt is sent to OpenAI.",
    critical: NO_REPEAT,
    details: [
      KEY_DETAIL,
      "Rasters suit photos, illustrations, textures and concepts. For an icon, logo or simple illustration that must scale or stay editable, output_format svg returns a static vector document; charts, diagrams and exact layouts are still better built as SVG or code directly.",
      "The result reports pixel dimensions for rasters, the header's frame size for GIF (frames and animation are not checked), and the viewBox or width and height for SVG, in vector units. An SVG is refused unless it is a static vector document without scripts, external resources or embedded rasters.",
      SIZE_IS_REQUESTED,
      ONE_IMAGE,
    ],
  }),
  schema: generateSchema,
  credential: openaiApiCredential,
  outputFormats: OUTPUT_FORMATS,
  request: (credential, args, signal) =>
    post(
      GENERATIONS_ENDPOINT,
      credential,
      {
        ...sharedBody(args),
        ...(args.frame_count != null ? { frame_count: args.frame_count } : {}),
        ...(args.frame_duration_ms != null ? { frame_duration_ms: args.frame_duration_ms } : {}),
        ...(args.svg_model ? { svg: { model: args.svg_model } } : {}),
      },
      signal,
    ),
} satisfies GenerationToolSpec<typeof generateSchema, typeof openaiApiCredential>

export const openaiApiImageedit = {
  operation: "edit",
  description: describeEditTool({
    subject: "the OpenAI Images API",
    discovery: DISCOVERY,
    requires: "Needs an OpenAI Images API key; the prompt and images are sent to OpenAI.",
    critical: `GIF and SVG come only from ${IMAGEGEN_TOOL}. ${NO_REPEAT}`,
    details: [KEY_DETAIL, SIZE_IS_REQUESTED, ONE_IMAGE],
  }),
  schema: editSchema,
  credential: openaiApiCredential,
  outputFormats: EDIT_OUTPUT_FORMATS,
  referenceRules: () => ({ mimeTypes: REFERENCE_MIME_TYPES, maxDataUrlLength: MAX_DATA_URL_LENGTH }),
  request: (credential, args, references, signal) =>
    post(
      EDITS_ENDPOINT,
      credential,
      { ...sharedBody(args), images: references.map((dataUrl) => ({ image_url: dataUrl })) },
      signal,
    ),
} satisfies EditToolSpec<typeof editSchema, typeof openaiApiCredential>

export const openaiApiModels = defineLookupTool({
  name: MODELS_TOOL,
  description: [
    `List the OpenAI image models this key can use now, from OpenAI's GET /v1/models, or check one exact model ID. Call it first, before choosing a model for ${IMAGEGEN_TOOL} or ${IMAGEEDIT_TOOL}.`,
    `${REQUIRES} Each call asks for permission and sends one GET request with the key; it generates nothing, and the answer is not cached or retried.`,
    `Without arguments it lists the gpt-image-* and chatgpt-image-* IDs and marks the default, ${DEFAULT_MODEL}.`,
    `The API reports only each ID, creation date, owner and shutdown date: a listed model is not proof that it supports SVG, GIF, a size or any other feature, and both image tools still send any model ID unchanged.`,
  ].join(" "),
  schema: openaiModelsSchema,
  credential: openaiApiCredential,
  lookup: ({ key }, args, signal) => lookUpOpenAiModels(key, args, signal, DEFAULT_MODEL),
})

export const openaiApiBackend = {
  id: "openai-api",
  summary: "OpenAI Images API (pixel sizes, transparency, GIF/SVG, live models)",
  credential: openaiApiCredential,
  tools: [defineImageTool(openaiApiImagegen), defineImageTool(openaiApiImageedit), openaiApiModels],
} satisfies Backend
