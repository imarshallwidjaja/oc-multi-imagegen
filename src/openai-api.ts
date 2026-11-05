import { z } from "zod"
import { defineImageTool, defineLookupTool, describeImagegen, IMAGEGEN_TOOL, MODELS_TOOL } from "./imagegen"
import { postImagesRequest } from "./images-request"
import { lookUpOpenAiModels, openaiModelsSchema } from "./openai-models"
import type { OutputFormat } from "./output-image"
import { createArgsShape } from "./schema"
import { type Backend, type CredentialSpec, expectHeaderSafeKey, type ImageCredential } from "./types"

// Official OpenAI Images API. The documented JSON body for edits takes references as images[].image_url data URLs.
// https://developers.openai.com/api/reference/resources/images/methods/generate
// https://developers.openai.com/api/reference/resources/images/methods/edit
const GENERATIONS_ENDPOINT = "https://api.openai.com/v1/images/generations"
const EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits"

// https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
const DEFAULT_MODEL = "gpt-image-2.6-sunburst"
const DEFAULT_QUALITY = "auto"

// The documented output formats. GIF and SVG come from the generations endpoint only, and a transparent background
// needs PNG or WebP.
// https://developers.openai.com/api/docs/guides/image-generation#generate-svg-output
// https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output
const OUTPUT_FORMATS = ["png", "jpeg", "webp", "gif", "svg"] as const satisfies readonly OutputFormat[]
const DEFAULT_OUTPUT_FORMAT = "png"
const GENERATION_ONLY_FORMATS: readonly OutputFormat[] = ["gif", "svg"]
const TRANSPARENT_FORMATS: readonly OutputFormat[] = ["png", "webp"]

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

const argsShape = createArgsShape({
  size: z
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
      `Requested image size as ${SIZE_RULE}, for example 1536x864. It is sent to the API unchanged; choose it by aspect ratio. Larger sizes cost more, resolutions above 2560x1440 are experimental, and the API rejects sizes the model does not support. For gif it is the size of each frame.`,
    ),
  maxImages: MAX_REFERENCE_IMAGES,
  imagesNote: "Each file must be PNG, JPEG or WebP. Not used with output_format gif or svg, which are generation-only.",
  savedFormats: OUTPUT_FORMATS,
  background:
    "Optional background. For png, jpeg and webp it defaults to opaque, and transparent needs output_format png or webp; use it for a cut-out instead of asking for one in the prompt. For gif and svg it is sent only when set, and only opaque is accepted. The returned alpha can be soft, and the tool does not check or clean it up.",
  model: `Optional model name, sent to the API unchanged. Defaults to ${DEFAULT_MODEL}. Call ${MODELS_TOOL} first to see the image models this key lists.`,
  quality: `Optional quality value, sent to the API unchanged. Defaults to ${DEFAULT_QUALITY}. For svg it controls the generated reference image.`,
})

const schema = z
  .object({
    ...argsShape,
    output_format: z
      .enum(OUTPUT_FORMATS)
      .nullish()
      .describe(
        "Optional output format: png (default), jpeg, webp, gif or svg. gif is an animated GIF and svg a static vector document authored from a generated reference image; both are generation-only. The bytes are saved as returned.",
      ),
    frame_count: z
      .number()
      .int()
      .min(FRAME_COUNT.min)
      .max(FRAME_COUNT.max)
      .nullish()
      .describe(
        `Optional number of GIF frames, ${FRAME_COUNT.min} to ${FRAME_COUNT.max}; only with output_format gif. Omitted, the API chooses (documented default 9). This is the tool's limit, not a proven provider maximum.`,
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
  })
  .superRefine((args, ctx) => {
    const format = args.output_format ?? DEFAULT_OUTPUT_FORMAT
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
    if (args.frame_count != null && format !== "gif") {
      issue("frame_count", "frame_count is only used with output_format gif.")
    }
    if (args.frame_duration_ms != null && format !== "gif") {
      issue("frame_duration_ms", "frame_duration_ms is only used with output_format gif.")
    }
    if (args.svg_model != null && format !== "svg") issue("svg_model", "svg_model is only used with output_format svg.")
    if (args.background === "transparent" && !TRANSPARENT_FORMATS.includes(format)) {
      issue("background", `A transparent background needs output_format png or webp, not ${format}.`)
    }
    if (GENERATION_ONLY_FORMATS.includes(format) && (args.images?.length ?? 0) > 0) {
      issue(
        "images",
        `output_format ${format} is generation-only: the OpenAI edits endpoint does not return it. Remove images, or use png, jpeg or webp.`,
      )
    }
  })

type OpenAiArgs = z.output<typeof schema>

const openaiApiCredential = {
  type: "key",
  provider: "openai-images",
  label: "OpenAI Images API",
  environmentVariable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
} as const satisfies CredentialSpec

// Sends one request. The raster formats keep the opaque background default; GIF and SVG send a background only when
// the caller sets one. The GIF and SVG fields go only with their format, and svg only when svg_model is set.
async function generate(
  credential: ImageCredential,
  args: OpenAiArgs,
  referenceDataUrls: string[],
  signal: AbortSignal,
): Promise<string> {
  const key = expectHeaderSafeKey(credential, openaiApiCredential.label)
  const isEdit = referenceDataUrls.length > 0
  const format = args.output_format ?? DEFAULT_OUTPUT_FORMAT
  const background = args.background ?? (GENERATION_ONLY_FORMATS.includes(format) ? undefined : "opaque")
  return postImagesRequest({
    label: "openai-api",
    url: isEdit ? EDITS_ENDPOINT : GENERATIONS_ENDPOINT,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: args.model ?? DEFAULT_MODEL,
      prompt: args.prompt,
      size: args.size,
      quality: args.quality ?? DEFAULT_QUALITY,
      ...(background ? { background } : {}),
      n: 1,
      output_format: format,
      stream: false,
      ...(args.frame_count != null ? { frame_count: args.frame_count } : {}),
      ...(args.frame_duration_ms != null ? { frame_duration_ms: args.frame_duration_ms } : {}),
      ...(args.svg_model ? { svg: { model: args.svg_model } } : {}),
      ...(isEdit ? { images: referenceDataUrls.map((dataUrl) => ({ image_url: dataUrl })) } : {}),
    },
    signal,
    secret: key,
  })
}

const REQUIRES = `Requires an OpenAI Images API key: the ${openaiApiCredential.environmentVariable} environment variable of the OpenCode process, or else the ${openaiApiCredential.provider} credential saved in OpenCode.`

export const openaiApiImagegen = {
  name: IMAGEGEN_TOOL,
  description: describeImagegen({
    subject: "the OpenAI Images API",
    requires: `${REQUIRES} The prompt and any reference images are sent to OpenAI.`,
    media: {
      what: "one image (a raster, an animated GIF or a static SVG)",
      medium:
        "Rasters suit photos, illustrations, textures and concepts. For an icon, logo or simple illustration that must scale or stay editable, output_format svg returns a static vector document; charts, diagrams and exact layouts are still better built as SVG or code directly.",
      saves:
        "Saves the native PNG, JPEG, WebP, GIF or SVG bytes and returns the actual absolute path and format: pixel dimensions for rasters, the header's frame size for GIF (frames and animation are not checked), and the viewBox or width and height for SVG, which are vector units. An SVG is refused unless it is a static vector document without scripts, external resources or embedded rasters. The extension is adjusted to match; use the returned out path for reads or subsequent edits. Size is a request, so check the dimensions when they matter.",
    },
    controls: `Call ${MODELS_TOOL} first to see which image models this key lists, then choose model, or omit it to send ${DEFAULT_MODEL}; model and quality (default ${DEFAULT_QUALITY}) are passed to the API unchanged. Size is a native WIDTHxHEIGHT sent to the API unchanged. output_format is png (default), jpeg, webp, gif or svg. For gif, size is each frame, frame_count (${FRAME_COUNT.min} to ${FRAME_COUNT.max}) and frame_duration_ms (${FRAME_DURATION_MS.min} to ${FRAME_DURATION_MS.max}) are optional tool limits, and all frames must fit the model's pixel budget: if the API rejects the request, use a smaller size or fewer frames. For svg, the API renders a reference image and an author model turns it into vectors; set svg_model only when the operator names one or the API asks for it, never a guessed one, and do not repeat a rejected call unchanged. gif and svg take no images. A transparent background needs png or webp. There is no image-count control, and other arguments are not sent to the provider.`,
  }),
  schema,
  references: (args: OpenAiArgs) => ({
    paths: args.images,
    rules: { mimeTypes: REFERENCE_MIME_TYPES, maxDataUrlLength: MAX_DATA_URL_LENGTH },
  }),
  generate,
  outputFormats: OUTPUT_FORMATS,
}

export const openaiApiModels = defineLookupTool({
  name: MODELS_TOOL,
  description: [
    `List the OpenAI image models this key can use now, from OpenAI's GET /v1/models, or check one exact model ID. Call it before choosing a model for ${IMAGEGEN_TOOL}: it is the expected first step of OpenAI image work.`,
    `Without arguments it lists the gpt-image-* and chatgpt-image-* IDs and marks the default, ${DEFAULT_MODEL}; query searches every listed ID with words that must all appear, for example to find an author model for svg_model; model checks one ID.`,
    `${REQUIRES} Each call asks for permission and sends one GET request with the key; it generates nothing, and the answer is not cached or retried.`,
    `The API reports only each ID, creation date, owner and shutdown date: a listed model is not proof that it supports SVG, GIF, a size or any other feature, and ${IMAGEGEN_TOOL} still sends any model ID unchanged.`,
  ].join(" "),
  schema: openaiModelsSchema,
  lookup: (credential, args, signal) =>
    lookUpOpenAiModels(expectHeaderSafeKey(credential, openaiApiCredential.label), args, signal, DEFAULT_MODEL),
})

export const openaiApiBackend = {
  id: "openai-api",
  credential: openaiApiCredential,
  tools: [defineImageTool(openaiApiImagegen), openaiApiModels],
} satisfies Backend
