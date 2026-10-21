import { z } from "zod"
import { postImagesRequest } from "./images-request"
import { createArgsShape, type GenerateArgs } from "./schema"
import { appendSizeToPrompt, IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"
import { type Backend, expectCredential, type ImageCredential } from "./types"

// Codex OAuth images endpoint URLs. Codex calls edits when reference images are given.
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

const argsShape = createArgsShape({
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
  maxImages: MAX_REFERENCE_IMAGES,
  model: `Optional model name, sent to the Codex backend unchanged. Omit it to send ${CODEX_REQUEST_DEFAULTS.model}. Whether the backend applies it is unverified in recorded runs and can change, so the result text lists it as requested, not verified.`,
  quality: `Optional quality value, sent to the Codex backend unchanged. Omit it to send ${CODEX_REQUEST_DEFAULTS.quality}. Whether the backend applies it is unverified in recorded runs and can change, so the result text lists it as requested, not verified.`,
})

async function generate(
  credential: ImageCredential,
  args: GenerateArgs,
  inputImageDataUrls: string[],
  signal: AbortSignal,
): Promise<string> {
  const auth = expectCredential(credential, "oauth")
  const isEdit = inputImageDataUrls.length > 0
  return postImagesRequest({
    label: "codex",
    url: isEdit ? CODEX_IMAGES_EDITS_ENDPOINT : CODEX_IMAGES_GENERATIONS_ENDPOINT,
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
      ...(isEdit ? { images: inputImageDataUrls.map((dataUrl) => ({ image_url: dataUrl })) } : {}),
    },
    signal,
    secret: auth.access,
  })
}

export const codexBackend = {
  id: "codex",
  credential: { type: "oauth", provider: "openai", label: "OpenAI ChatGPT OAuth" },
  description: {
    subject: "the ChatGPT Codex image backend",
    requires:
      "Requires OpenCode ChatGPT OAuth authentication. The prompt and any reference images are sent to the provider.",
    controls:
      "Optional model and quality are sent unchanged, but whether this backend applies them is unverified and can change; when you set either, the result text separates what was requested from what is verified. There are no image-count or output-format controls, and other arguments are not sent to the provider.",
  },
  argsSchema: z.object(argsShape),
  references: {},
  generate,
  resultNote(args) {
    const requested = [args.model && `model ${args.model}`, args.quality && `quality ${args.quality}`].filter(Boolean)
    if (requested.length === 0) return undefined
    return `Requested ${requested.join(" and ")}; the Codex response does not report which settings it applied, so they are unverified.`
  },
} satisfies Backend
