import { z } from "zod"
import { postImagesRequest } from "./images-request"
import { createArgsShape, type GenerateArgs } from "./schema"
import { type Backend, expectCredential, type ImageCredential } from "./types"

// Official OpenAI Images API. The documented JSON body for edits takes references as images[].image_url data URLs.
// https://developers.openai.com/api/reference/resources/images/methods/generate
// https://developers.openai.com/api/reference/resources/images/methods/edit
const GENERATIONS_ENDPOINT = "https://api.openai.com/v1/images/generations"
const EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits"

// https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
const DEFAULT_MODEL = "gpt-image-2.5-sunburst"
const DEFAULT_QUALITY = "auto"

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
      `Requested image size as ${SIZE_RULE}, for example 1536x864. It is sent to the API unchanged; choose it by aspect ratio. Larger sizes cost more, resolutions above 2560x1440 are experimental, and the API rejects sizes the model does not support.`,
    ),
  maxImages: MAX_REFERENCE_IMAGES,
  imagesNote: "Each file must be PNG, JPEG or WebP.",
  model: `Optional model name, sent to the API unchanged. Defaults to ${DEFAULT_MODEL}.`,
  quality: `Optional quality value, sent to the API unchanged. Defaults to ${DEFAULT_QUALITY}.`,
})

// Header values cannot hold whitespace or control characters; fetch would otherwise reject the value in an error
// message that quotes it.
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/

async function generate(
  credential: ImageCredential,
  args: GenerateArgs,
  referenceDataUrls: string[],
  signal: AbortSignal,
): Promise<string> {
  const { key } = expectCredential(credential, "key")
  if (!HEADER_SAFE_KEY.test(key)) {
    throw new Error("The OpenAI Images API key contains characters that cannot be sent in an HTTP header.")
  }
  const isEdit = referenceDataUrls.length > 0
  return postImagesRequest({
    label: "openai-api",
    url: isEdit ? EDITS_ENDPOINT : GENERATIONS_ENDPOINT,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: args.model ?? DEFAULT_MODEL,
      prompt: args.prompt,
      size: args.size,
      quality: args.quality ?? DEFAULT_QUALITY,
      background: args.background ?? "opaque",
      n: 1,
      output_format: "png",
      stream: false,
      ...(isEdit ? { images: referenceDataUrls.map((dataUrl) => ({ image_url: dataUrl })) } : {}),
    },
    signal,
    secret: key,
  })
}

export const openaiApiBackend = {
  id: "openai-api",
  credential: {
    type: "key",
    provider: "openai-images",
    label: "OpenAI Images API",
    environmentVariable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
  },
  description: {
    subject: "the OpenAI Images API",
    requires:
      "Requires an OpenAI Images API key: the OC_MULTI_IMAGEGEN_OPENAI_API_KEY environment variable of the OpenCode process, or else the openai-images credential saved in OpenCode. The prompt and any reference images are sent to OpenAI.",
    controls: `Size is a native WIDTHxHEIGHT sent to the API unchanged. Optional model (default ${DEFAULT_MODEL}) and quality (default ${DEFAULT_QUALITY}) are passed to the API unchanged. There are no image-count or output-format controls, and other arguments are not sent to the provider.`,
  },
  argsSchema: z.object(argsShape),
  references: { mimeTypes: REFERENCE_MIME_TYPES, maxDataUrlLength: MAX_DATA_URL_LENGTH },
  generate,
} satisfies Backend
