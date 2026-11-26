import { z } from "zod"
import type { CredentialSpec, HostCredential, HostGenerateImageInput, HostImageModel } from "./credential"
import { RASTER_FORMATS } from "./image-format"
import {
  defineImageTool,
  defineLookupTool,
  describeEditTool,
  describeGenerationTool,
  type EditToolSpec,
  type GenerationToolSpec,
  RASTER_MEDIUM,
} from "./imagegen"
import {
  GENERATION_MOVED_ARGUMENTS,
  IMAGEEDIT_TOOL,
  IMAGEGEN_TOOL,
  MODELS_TOOL,
  NO_REFERENCES,
  outField,
  PROMPT_DESCRIPTION,
  previewField,
  REFERENCE_ENTRIES,
  strictArgs,
} from "./schema"
import type { Backend } from "./types"

// OpenCode 2's own image generation: the host runs the request with one of the image models its connected providers
// offer, through ctx.experimental.generate.image, and lists them through ctx.model.list. OpenCode 1 has neither, so
// this backend runs only on OpenCode 2.

const OUTPUT_FORMATS = RASTER_FORMATS
const MAX_REFERENCE_IMAGES = 8
const REFERENCE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

const opencodeCredential = {
  type: "host",
  provider: "opencode",
  label: "OpenCode connected image model",
} as const satisfies CredentialSpec

type ModelRef = HostGenerateImageInput["model"]

const MODEL_FORMAT = "providerID/modelID or providerID/modelID#variant"

// Splits "providerID/modelID#variant" on the first "/" and the first "#" after it, so a model ID can hold further
// slashes (openrouter/black-forest-labs/flux-2-pro#hd). Like OpenCode's own model references, "#" appears at most
// once and only after the provider ID.
function parseModelRef(raw: string): ModelRef {
  const slash = raw.indexOf("/")
  if (slash < 0) throw new Error(`Model "${raw}" has no provider. Use ${MODEL_FORMAT}.`)
  const providerID = raw.slice(0, slash)
  const rest = raw.slice(slash + 1)
  const hash = rest.indexOf("#")
  const id = hash < 0 ? rest : rest.slice(0, hash)
  const variant = hash < 0 ? undefined : rest.slice(hash + 1)
  if (!providerID) throw new Error(`Model "${raw}" has an empty provider ID. Use ${MODEL_FORMAT}.`)
  if (providerID.includes("#")) throw new Error(`Model "${raw}" has "#" in its provider ID. Use ${MODEL_FORMAT}.`)
  if (!id) throw new Error(`Model "${raw}" has an empty model ID. Use ${MODEL_FORMAT}.`)
  if (variant === "") throw new Error(`Model "${raw}" has an empty variant after "#". Use ${MODEL_FORMAT}.`)
  if (variant?.includes("#")) throw new Error(`Model "${raw}" has more than one "#". Use ${MODEL_FORMAT}.`)
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

const isEnabledImageModel = (model: HostImageModel) =>
  model.enabled &&
  (model.type === "image" || model.capabilities.output.some((capability) => capability.startsWith("image")))

const acceptsInputImages = (model: HostImageModel) =>
  model.capabilities.input.some((capability) => capability.startsWith("image"))

const refOf = (model: HostImageModel) => `${model.providerID}/${model.id}`

const modelField = (operation: string) =>
  z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      try {
        parseModelRef(value)
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message })
      }
    })
    .describe(
      `Required image model as ${MODEL_FORMAT}, from ${MODELS_TOOL}${operation === "edit" ? ", which marks the models that accept input images (edit: yes)" : ""}. The model ID can contain further slashes.`,
    )

const ASPECT = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/
const ASPECT_MESSAGE = "Use an aspect ratio WIDTH:HEIGHT of positive numbers, for example 16:9."
type AspectRatio = `${number}:${number}`
const controlFields = {
  aspect: z
    .string()
    .regex(ASPECT, ASPECT_MESSAGE)
    .refine(
      (value) => value.split(":").every((part) => Number.isFinite(Number(part)) && Number(part) > 0),
      ASPECT_MESSAGE,
    )
    .nullish()
    .describe(
      "Optional aspect ratio WIDTH:HEIGHT, for example 1:1, 16:9 or 9:16, passed to the model's provider. Omitted, the provider chooses.",
    ),
  resolution: z
    .string()
    .min(1)
    .nullish()
    .describe(
      "Optional resolution passed to the model's provider, for example 1K, 2K or 4K. Omitted, the provider chooses.",
    ),
}

const SIZE_MOVED = "This backend takes no size: use aspect (for example 16:9) and resolution (for example 2K) instead."

const generateSchema = strictArgs(
  IMAGEGEN_TOOL,
  {
    prompt: z.string().min(1).describe(PROMPT_DESCRIPTION.generate),
    out: outField(OUTPUT_FORMATS),
    model: modelField("generate"),
    ...controlFields,
    preview: previewField(),
  },
  { ...GENERATION_MOVED_ARGUMENTS, size: SIZE_MOVED },
)

const editSchema = strictArgs(
  IMAGEEDIT_TOOL,
  {
    prompt: z.string().min(1).describe(PROMPT_DESCRIPTION.edit),
    out: outField(OUTPUT_FORMATS),
    model: modelField("edit"),
    images: z
      .array(z.string().min(1), {
        error: (issue) => (issue.input == null ? `Missing images. ${NO_REFERENCES}` : undefined),
      })
      .min(1, NO_REFERENCES)
      .max(MAX_REFERENCE_IMAGES, `${IMAGEEDIT_TOOL} takes at most ${MAX_REFERENCE_IMAGES} reference images.`)
      .describe(
        `Required reference images, 1 to ${MAX_REFERENCE_IMAGES}: ${REFERENCE_ENTRIES}. They are sent in order, so call them Image 1, Image 2 in the prompt. Each must be PNG, JPEG, WebP or GIF and at most 20 MiB. Their contents are uploaded to the model's provider.`,
      ),
    ...controlFields,
    preview: previewField(),
  },
  { size: SIZE_MOVED },
)

type GenerateArgs = z.output<typeof generateSchema>
type EditArgs = z.output<typeof editSchema>

// Checks the requested model against the host's model catalog before anything is generated:
// it must be an enabled image model, the variant must exist, and an edit needs a model that accepts input images.
async function catalogModel(
  credential: HostCredential,
  raw: string,
  operation: "generate" | "edit",
  signal: AbortSignal,
) {
  const ref = parseModelRef(raw)
  const models = (await credential.listImageModels(signal)).filter(isEnabledImageModel)
  const model = models.find((candidate) => candidate.providerID === ref.providerID && candidate.id === ref.id)
  if (!model) {
    throw new Error(
      `${ref.providerID}/${ref.id} is not an enabled image model in OpenCode. Call ${MODELS_TOOL} to list the available ones.`,
    )
  }
  if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant)) {
    const available = model.variants.map((variant) => variant.id)
    throw new Error(
      available.length
        ? `${refOf(model)} has no variant "${ref.variant}". Its variants are: ${available.join(", ")}.`
        : `${refOf(model)} has no variants; omit "#${ref.variant}".`,
    )
  }
  if (operation === "edit" && !acceptsInputImages(model)) {
    const capable = models.filter(acceptsInputImages).slice(0, 3).map(refOf)
    throw new Error(
      capable.length
        ? `${refOf(model)} does not accept input images, so it cannot edit. Models that can include: ${capable.join(", ")}.`
        : `${refOf(model)} does not accept input images, and no enabled image model in OpenCode does.`,
    )
  }
  return ref
}

// "data:<mime>;base64,<data>", as readReferenceImages encodes each reference.
function referenceImage(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error("A reference image could not be encoded for OpenCode.")
  return { mime: match[1], data: match[2] }
}

async function generate(
  credential: HostCredential,
  args: GenerateArgs | EditArgs,
  operation: "generate" | "edit",
  references: string[],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const model = await catalogModel(credential, args.model, operation, signal)
  // OpenCode 2.3.2 ignores the signal passed to model.list, so a cancelled call must stop before a billable generation.
  signal.throwIfAborted()
  const images = references.length ? references.map(referenceImage) : undefined
  const result = await credential.generateImage(
    {
      model,
      prompt: args.prompt,
      n: 1,
      ...(images ? { images } : {}),
      // The schema accepts only WIDTH:HEIGHT ratios of positive numbers.
      ...(args.aspect ? { aspect: args.aspect as AspectRatio } : {}),
      ...(args.resolution ? { resolution: args.resolution } : {}),
    },
    signal,
  )
  const data = result?.images?.[0]?.data
  if (typeof data !== "string" || data === "") {
    throw new Error(`OpenCode returned no image for ${model.providerID}/${model.id}.`)
  }
  return Buffer.from(data, "base64")
}

function resultNote(args: GenerateArgs | EditArgs) {
  const requested = [
    args.aspect ? `aspect ${args.aspect}` : undefined,
    args.resolution ? `resolution ${args.resolution}` : undefined,
  ].filter(Boolean)
  return requested.length
    ? `Requested ${requested.join(" and ")}; OpenCode does not report what the provider applied, so only the pixel dimensions above are verified.`
    : undefined
}

const SUBJECT = "an OpenCode-connected image model"
const DISCOVERY = `Call ${MODELS_TOOL} first and pass a providerID/modelID it lists as model.`
const NO_REPEAT = "Do not repeat a rejected call unchanged."
const ASPECT_DETAIL =
  "Set the shape with aspect and resolution, not size; they are requests, so check the returned dimensions when they matter."
const ONE_IMAGE = "Each call makes one image."

export const opencodeImagegen = {
  operation: "generate",
  description: describeGenerationTool({
    subject: SUBJECT,
    discovery: DISCOVERY,
    requires: "Uses the model's OpenCode provider connection; the prompt is sent to it.",
    critical: NO_REPEAT,
    details: [RASTER_MEDIUM, ASPECT_DETAIL, ONE_IMAGE],
  }),
  schema: generateSchema,
  credential: opencodeCredential,
  outputFormats: OUTPUT_FORMATS,
  resultNote,
  request: (credential, args, signal) => generate(credential, args, "generate", [], signal),
} satisfies GenerationToolSpec<typeof generateSchema, typeof opencodeCredential>

export const opencodeImageedit = {
  operation: "edit",
  description: describeEditTool({
    subject: SUBJECT,
    discovery: `Call ${MODELS_TOOL} first and pass a model it marks edit: yes.`,
    requires: "Uses the model's OpenCode provider connection; the prompt and images are sent to it.",
    critical: NO_REPEAT,
    details: [ASPECT_DETAIL, ONE_IMAGE],
  }),
  schema: editSchema,
  credential: opencodeCredential,
  outputFormats: OUTPUT_FORMATS,
  referenceRules: () => ({ mimeTypes: REFERENCE_MIME_TYPES, maxBytes: MAX_REFERENCE_BYTES }),
  resultNote,
  request: (credential, args, references, signal) => generate(credential, args, "edit", references, signal),
} satisfies EditToolSpec<typeof editSchema, typeof opencodeCredential>

const modelsSchema = z
  .strictObject({
    query: z
      .string()
      .min(1)
      .nullish()
      .describe("Words that must all appear, ignoring case, in a model's providerID/modelID or display name."),
    model: z.string().min(1).nullish().describe("One exact providerID/modelID to look up."),
  })
  .superRefine((args, ctx) => {
    if (args.model && args.query) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "model cannot be combined with query." })
    }
  })

function describeModel(model: HostImageModel) {
  const variants = model.variants.length ? `; variants: ${model.variants.map((variant) => variant.id).join(", ")}` : ""
  return `- ${refOf(model)} (${model.name}); edit: ${acceptsInputImages(model) ? "yes" : "no"}${variants}`
}

function listModels(all: readonly HostImageModel[], args: z.output<typeof modelsSchema>) {
  const models = all.filter(isEnabledImageModel)
  if (args.model) {
    const found = models.find((model) => refOf(model) === args.model)
    return found
      ? describeModel(found)
      : `${args.model} is not an enabled image model in OpenCode. Call ${MODELS_TOOL} without arguments to list them.`
  }
  const words = args.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const matching = models.filter((model) => {
    const text = `${refOf(model)} ${model.name}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
  const scope = words.length ? ` matching "${args.query}"` : ""
  if (!matching.length) {
    return models.length
      ? `No enabled image model${scope}; ${models.length} enabled image models exist. Call ${MODELS_TOOL} without a query to list them.`
      : "No enabled image model is connected in OpenCode. Connect a provider that offers image models, then call this again."
  }
  return [
    `Enabled OpenCode image models${scope} (${matching.length} of ${models.length}). Pass providerID/modelID, or providerID/modelID#variant, as model:`,
    ...matching.map(describeModel),
  ].join("\n")
}

export const opencodeModels = defineLookupTool({
  name: MODELS_TOOL,
  description: [
    `List the enabled image models OpenCode's connected providers offer, or check one exact providerID/modelID. Call it first, before choosing a model for ${IMAGEGEN_TOOL} or ${IMAGEEDIT_TOOL}.`,
    "Each entry shows its variants and whether it accepts input images (edit: yes), which imageedit needs.",
    "It asks for permission, generates nothing and is not cached.",
  ].join(" "),
  schema: modelsSchema,
  credential: opencodeCredential,
  lookup: async (credential, args, signal) => listModels(await credential.listImageModels(signal), args),
})

export const opencodeBackend = {
  id: "opencode",
  summary: "OpenCode connected image models (aspect and resolution)",
  credential: opencodeCredential,
  tools: [defineImageTool(opencodeImagegen), defineImageTool(opencodeImageedit), opencodeModels],
} satisfies Backend
