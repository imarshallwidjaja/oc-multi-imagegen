import { z } from "zod"
import { defineInfoTool, IMAGEGEN_TOOL } from "./imagegen"
import { SKILL_NAME } from "./skill"

// The NanoGPT models this plugin supports, and the one place that says what each accepts. Tool schemas, validation,
// request bodies, the tool descriptions and the imagegen_models answers all derive from MODELS. The entries come from
// NanoGPT's documentation and public model metadata (see MODEL_SOURCES); no request is made to read them, and a
// model that is not listed is not supported, even if NanoGPT offers it. A control that an entry omits is not sent:
// absence here means "not supported by this plugin", not "unsupported by the provider".

export type Operation = "generate" | "edit"

export const GENERATE_TOOL = IMAGEGEN_TOOL
export const EDIT_TOOL = "imageedit"
export const MODELS_TOOL = "imagegen_models"

export const MODEL_SOURCES = [
  "https://docs.nano-gpt.com/api-reference/endpoint/image-api-generate",
  "https://api.nano-gpt.com/api/v1/images/models/<model ID>/endpoints",
]

export type NanoModel = {
  id: string
  operation: Operation
  family: string
  name: string
  purpose: string
  // The controls the model takes; only these are accepted and sent.
  resolutions: readonly string[]
  aspectRatios?: readonly string[]
  qualities?: readonly string[]
  backgrounds?: readonly string[]
  seed?: boolean
  // True when NanoGPT documents output_format for the model, so the request asks for PNG.
  requestsPng?: boolean
  maxPromptCodePoints?: number
  // Edit models only.
  maxReferences?: number
  referenceMaxBytes?: number
  notes?: string
}

type FamilySpec = Omit<
  NanoModel,
  "id" | "operation" | "purpose" | "aspectRatios" | "maxReferences" | "referenceMaxBytes"
> & {
  generateId: string
  editId: string
  purpose: string
  aspectRatios?: readonly string[]
  editAspectRatios?: readonly string[]
  // Appended to `notes` for the edit model only.
  editNotes?: string
  maxReferences: number
  referenceMaxBytes?: number
}

// Each family lists its generation model and its edit model, which NanoGPT publishes as separate model IDs.
function family(spec: FamilySpec): NanoModel[] {
  const { generateId, editId, editAspectRatios, editNotes, maxReferences, referenceMaxBytes, purpose, ...shared } = spec
  return [
    { ...shared, id: generateId, operation: "generate", purpose: `${purpose} Creates an image from text.` },
    {
      ...shared,
      id: editId,
      operation: "edit",
      aspectRatios: editAspectRatios ?? shared.aspectRatios,
      notes: [shared.notes, editNotes].filter(Boolean).join(" ") || undefined,
      purpose: `${purpose} Edits or combines up to ${maxReferences} reference images.`,
      maxReferences,
      referenceMaxBytes,
    },
  ]
}

const SIZE_TIERS = ["1k", "2k", "4k"] as const

export const MODELS: readonly NanoModel[] = [
  ...family({
    family: "gpt-image-flare",
    name: "GPT Image 2.5 Flare",
    generateId: "openai/gpt-image-2.5/flare/text-to-image",
    editId: "openai/gpt-image-2.5/flare/edit",
    purpose:
      "OpenAI GPT Image 2.5 Flare. The only supported family with quality tiers and a transparent-background option; choose it when either is needed.",
    resolutions: SIZE_TIERS,
    aspectRatios: [
      "1:1",
      "1:2",
      "2:1",
      "1:3",
      "3:1",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "9:16",
      "16:9",
      "9:21",
      "21:9",
    ],
    qualities: ["low", "medium", "high", "xhigh", "max"],
    backgrounds: ["auto", "opaque", "transparent"],
    requestsPng: true,
    maxPromptCodePoints: 32000,
    maxReferences: 16,
  }),
  ...family({
    family: "nano-banana-pro",
    name: "Nano Banana Pro",
    generateId: "nano-banana-pro",
    editId: "nano-banana-pro-edit",
    purpose:
      "Nano Banana Pro, which the provider describes as a high-resolution text and edit model for up to 4K output with flexible aspect ratios; its edits keep the lighting and composition of the references.",
    resolutions: SIZE_TIERS,
    aspectRatios: ["auto", "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    maxReferences: 10,
  }),
  ...family({
    family: "flux-3",
    name: "FLUX.3 Image",
    generateId: "black-forest-labs/flux-3/text-to-image",
    editId: "black-forest-labs/flux-3/edit",
    purpose:
      "Black Forest Labs FLUX.3 Image, which the provider describes as detailed photographs, illustrations and designs with accurate typography, and edits that replace backgrounds, revise text or compose references.",
    resolutions: SIZE_TIERS,
    aspectRatios: [
      "auto",
      "21:9",
      "2:1",
      "16:9",
      "3:2",
      "7:5",
      "4:3",
      "5:4",
      "1:1",
      "4:5",
      "3:4",
      "5:7",
      "2:3",
      "9:16",
      "1:2",
    ],
    requestsPng: true,
    maxReferences: 10,
    editNotes:
      "The provider documents references of at least 256 pixels on each side and at most 16 megapixels, and downscales references above 4 megapixels. The plugin does not check pixel sizes.",
  }),
  ...family({
    family: "seedream-5-pro",
    name: "Seedream 5.0 Pro",
    generateId: "bytedance/seedream-v5.0-pro",
    editId: "bytedance/seedream-v5.0-pro/edit",
    purpose:
      "ByteDance Seedream 5.0 Pro, which the provider describes as high-quality text-to-image generation and editing.",
    resolutions: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "1k", "2k"],
    maxReferences: 10,
    referenceMaxBytes: 10485760,
    notes:
      "Size is chosen only through resolution: 1k, 2k, or an aspect-ratio value such as 16:9. There is no separate aspect_ratio argument.",
  }),
  ...family({
    family: "qwen-image-2.1",
    name: "Qwen Image 2.1",
    generateId: "qwen-image-2.1/text-to-image",
    editId: "qwen-image-2.1/edit",
    purpose:
      "Qwen Image 2.1, which the provider describes as strong prompt following, multilingual text rendering and native output up to 2K; its edit model keeps the subject of the references.",
    resolutions: ["1k", "1.5k", "2k"],
    aspectRatios: [
      "1:1",
      "1:2",
      "2:1",
      "1:3",
      "3:1",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "9:16",
      "16:9",
      "9:21",
      "21:9",
    ],
    editAspectRatios: [
      "auto",
      "1:1",
      "1:2",
      "2:1",
      "1:3",
      "3:1",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "9:16",
      "16:9",
      "9:21",
      "21:9",
    ],
    seed: true,
    requestsPng: true,
    maxReferences: 10,
  }),
]

export const FAMILIES = [...new Set(MODELS.map((model) => model.family))]

// NanoGPT's route-level limits for every reference image (formats and file size).
export const REFERENCE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const
export const ROUTE_REFERENCE_MAX_BYTES = 31457280

const TOOL_OF: Record<Operation, string> = { generate: GENERATE_TOOL, edit: EDIT_TOOL }
const OTHER: Record<Operation, Operation> = { generate: "edit", edit: "generate" }

function nonEmpty(values: string[]): [string, ...string[]] {
  const [first, ...rest] = values
  if (first === undefined) throw new Error("The NanoGPT model registry has no entries for an operation.")
  return [first, ...rest]
}

export const modelIds = (operation: Operation) =>
  nonEmpty(MODELS.filter((model) => model.operation === operation).map((model) => model.id))

export function findModel(operation: Operation, id: string): NanoModel | undefined {
  return MODELS.find((model) => model.operation === operation && model.id === id)
}

// The model for the other operation in the same family, for pointing an agent at the right tool.
function counterpart(model: NanoModel): NanoModel | undefined {
  return MODELS.find((candidate) => candidate.family === model.family && candidate.operation !== model.operation)
}

export function referenceRules(model: NanoModel) {
  return { mimeTypes: REFERENCE_MIME_TYPES, maxBytes: model.referenceMaxBytes ?? ROUTE_REFERENCE_MAX_BYTES }
}

export const CONTROL_NAMES = ["resolution", "aspect_ratio", "quality", "background", "seed"] as const
export type ControlName = (typeof CONTROL_NAMES)[number]
export type Control = { name: ControlName; values?: readonly string[] }

export function controlsOf(model: NanoModel): Control[] {
  return [
    { name: "resolution", values: model.resolutions },
    ...(model.aspectRatios ? [{ name: "aspect_ratio", values: model.aspectRatios } as const] : []),
    ...(model.qualities ? [{ name: "quality", values: model.qualities } as const] : []),
    ...(model.backgrounds ? [{ name: "background", values: model.backgrounds } as const] : []),
    ...(model.seed ? [{ name: "seed" } as const] : []),
  ]
}

// The wire fields a call sends for the model, apart from the prompt, model and references.
export function controlFields(
  model: NanoModel,
  args: Partial<Record<ControlName, string | number | null | undefined>>,
): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  for (const name of CONTROL_NAMES) {
    const value = args[name]
    if (value !== undefined && value !== null) fields[name] = value
  }
  if (model.requestsPng) fields.output_format = "png"
  return fields
}

const codePoints = (text: string) => [...text.trim()].length

type CheckedArgs = {
  model: string
  prompt: string
  resolution?: string | null
  aspect_ratio?: string | null
  quality?: string | null
  background?: string | null
  seed?: number | null
  images?: string[]
}

// Everything the model-independent schema cannot say: which controls and values the chosen model takes, the prompt
// length and the reference count. It runs on every call, before anything is paid for.
function checkAgainstModel(operation: Operation) {
  return (args: CheckedArgs, ctx: z.RefinementCtx) => {
    // An unknown model is reported by the model field itself.
    const model = findModel(operation, args.model)
    if (!model) return
    const reject = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
    const controls = controlsOf(model)
    for (const name of CONTROL_NAMES) {
      const value = args[name]
      if (value === undefined || value === null) continue
      const control = controls.find((candidate) => candidate.name === name)
      if (!control) {
        reject(
          name,
          `${name} is not supported by ${model.id}, which takes ${controls.map((candidate) => candidate.name).join(", ")}. Omit ${name}, or choose a model that lists it (call ${MODELS_TOOL}).`,
        )
      } else if (control.values && !control.values.includes(String(value))) {
        reject(
          name,
          `Unsupported ${name} ${JSON.stringify(value)} for ${model.id}. Use one of: ${control.values.join(", ")}.`,
        )
      }
    }
    if (model.maxPromptCodePoints && codePoints(args.prompt) > model.maxPromptCodePoints) {
      reject(
        "prompt",
        `The prompt is ${codePoints(args.prompt)} characters; ${model.id} accepts at most ${model.maxPromptCodePoints}.`,
      )
    }
    if (operation === "edit" && model.maxReferences && (args.images?.length ?? 0) > model.maxReferences) {
      reject(
        "images",
        `${model.id} takes at most ${model.maxReferences} reference images; ${args.images?.length} were given.`,
      )
    }
  }
}

function modelError(operation: Operation, input: unknown): string {
  const tool = TOOL_OF[operation]
  const ids = modelIds(operation).join(", ")
  if (input === undefined || input === null)
    return `Missing model. ${tool} requires one of: ${ids}. Call ${MODELS_TOOL} to choose.`
  const other =
    typeof input === "string"
      ? MODELS.find((model) => model.operation === OTHER[operation] && model.id === input)
      : undefined
  if (other) {
    const same = counterpart(other)
    return `${other.id} is for ${TOOL_OF[other.operation]}, not ${tool}. Use ${TOOL_OF[other.operation]} with it${same ? `, or ${tool} with ${same.id}` : ""}.`
  }
  const shown = typeof input === "string" ? JSON.stringify(input.slice(0, 80)) : "that value"
  return `Unsupported ${operation} model ${shown}. Use one of: ${ids}. Call ${MODELS_TOOL} for details.`
}

function unrecognizedArguments(operation: Operation, accepted: string[]) {
  return (issue: z.core.$ZodRawIssue) => {
    if (issue.code !== "unrecognized_keys") return undefined
    const names = issue.keys.join(", ")
    const advice =
      operation === "generate" && issue.keys.includes("images")
        ? `${GENERATE_TOOL} creates a new image from text; use ${EDIT_TOOL} to change or combine existing images.`
        : `${TOOL_OF[operation]} accepts: ${accepted.join(", ")}.`
    return `Unsupported argument${issue.keys.length === 1 ? "" : "s"}: ${names}. ${advice}`
  }
}

const optionalControl = (description: string) => z.string().min(1).nullish().describe(description)

function commonShape(operation: Operation) {
  const ids = modelIds(operation)
  return {
    model: z
      .enum(ids, { error: (issue) => modelError(operation, issue.input) })
      .describe(
        `Required exact model ID. Nothing is chosen for you and a failure is never retried with another model. Call ${MODELS_TOOL} for each model's purpose, controls and limits.`,
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        operation === "edit"
          ? "The edit to make, in natural language. Name each reference image's role (Image 1, Image 2, in the order of images) and what to keep. Put every visible string in quotes."
          : "Description of the image to generate. Put every visible string in quotes.",
      ),
    out: z
      .string()
      .describe(
        "Destination path, relative to the project directory unless absolute. The file always contains PNG bytes; the extension does not select or convert the format. An existing file is kept and the new image gets a -vN suffix.",
      ),
    resolution: optionalControl(
      "Optional output resolution tier, a value from the chosen model's list in " +
        `${MODELS_TOOL}. Omit it to let NanoGPT use the model's default.`,
    ),
    aspect_ratio: optionalControl(
      `Optional aspect ratio such as 16:9, only for models that list it in ${MODELS_TOOL}. Omit it to let NanoGPT use the model's default.`,
    ),
    quality: optionalControl(
      `Optional quality tier, only for models that list it in ${MODELS_TOOL} (GPT Image 2.5 Flare). Omit it to use the provider default.`,
    ),
    background: optionalControl(
      `Optional background (auto, opaque or transparent), only for models that list it in ${MODELS_TOOL} (GPT Image 2.5 Flare). Use transparent for a cut-out instead of asking in the prompt; the returned alpha can be soft and the tool does not check it.`,
    ),
    seed: z
      .number()
      .int()
      .nullish()
      .describe(
        `Optional integer seed, only for models that list it in ${MODELS_TOOL}. It may help reproducibility but does not guarantee identical output.`,
      ),
  }
}

const COMMON_ARGUMENTS = ["model", "prompt", "out", "resolution", "aspect_ratio", "quality", "background", "seed"]

// Both tools use one stable object schema; the chosen model narrows it through checkAgainstModel. Unknown
// arguments are rejected instead of dropped.
export const generateSchema = z
  .strictObject(commonShape("generate"), { error: unrecognizedArguments("generate", COMMON_ARGUMENTS) })
  .superRefine(checkAgainstModel("generate"))

const MAX_EDIT_REFERENCES = Math.max(...MODELS.map((model) => model.maxReferences ?? 0))

export const editSchema = z
  .strictObject(
    {
      ...commonShape("edit"),
      images: z
        .array(z.string().min(1))
        .min(1, `${EDIT_TOOL} needs at least one reference image. Use ${GENERATE_TOOL} to create an image from text.`)
        .max(MAX_EDIT_REFERENCES)
        .describe(
          "Required local paths of the images to edit or combine, relative to the project directory unless absolute; they are sent in order, so call them Image 1, Image 2 in the prompt. Each file must be PNG, JPEG or WebP. The count limit depends on the model. Their contents are uploaded to NanoGPT.",
        ),
    },
    { error: unrecognizedArguments("edit", [...COMMON_ARGUMENTS, "images"]) },
  )
  .superRefine(checkAgainstModel("edit"))

// The request arguments for one model as JSON Schema, derived from the same entry the validation uses.
function requestSchema(model: NanoModel) {
  const properties: Record<string, object> = {
    model: { const: model.id },
    prompt: {
      type: "string",
      minLength: 1,
      ...(model.maxPromptCodePoints ? { maxLength: model.maxPromptCodePoints } : {}),
    },
    out: { type: "string" },
  }
  for (const control of controlsOf(model)) {
    properties[control.name] = control.values ? { type: "string", enum: control.values } : { type: "integer" }
  }
  if (model.operation === "edit") {
    properties.images = {
      type: "array",
      minItems: 1,
      maxItems: model.maxReferences,
      items: { type: "string", minLength: 1 },
    }
  }
  return {
    tool: TOOL_OF[model.operation],
    type: "object",
    additionalProperties: false,
    required: ["model", "prompt", "out", ...(model.operation === "edit" ? ["images"] : [])],
    properties,
  }
}

function describeDetail(model: NanoModel): string {
  const same = counterpart(model)
  const lines = [
    `${model.id} (${model.name}, ${model.operation} model, used with ${TOOL_OF[model.operation]})`,
    model.purpose,
    ...(same ? [`The ${same.operation} model of this family is ${same.id} (${TOOL_OF[same.operation]}).`] : []),
    ...controlsOf(model).map((control) =>
      control.values ? `- ${control.name}: ${control.values.join(", ")}` : `- ${control.name}: an integer`,
    ),
    "Omitted controls are not sent, so NanoGPT applies its own defaults.",
    model.requestsPng
      ? "The request asks for PNG output."
      : "The request does not set an output format; the response must be PNG.",
    ...(model.maxPromptCodePoints ? [`Prompt: at most ${model.maxPromptCodePoints} characters.`] : []),
    ...(model.operation === "edit"
      ? [
          `References: 1 to ${model.maxReferences} local PNG, JPEG or WebP files, each at most ${referenceRules(model).maxBytes} bytes.`,
        ]
      : ["References: none. Use the edit model to change existing images."]),
    ...(model.notes ? [model.notes] : []),
    `Sources: ${MODEL_SOURCES.join(" and ")}. Not validated with live calls.`,
    "Arguments (JSON Schema):",
    JSON.stringify(requestSchema(model), null, 2),
  ]
  return lines.join("\n")
}

function describeList(models: readonly NanoModel[], total: number): string {
  const group = (operation: Operation) =>
    models
      .filter((model) => model.operation === operation)
      .map(
        (model) =>
          `- ${model.id} (${model.name}): ${model.purpose} Controls: ${controlsOf(model)
            .map((control) => control.name)
            .join(", ")}.`,
      )
  const generate = group("generate")
  const edit = group("edit")
  return [
    `NanoGPT models this plugin supports (${models.length} of ${total} shown). Support is taken from provider documentation and public model metadata; it has not been validated with live calls. Prices vary by model, resolution and quality; check NanoGPT's pricing when cost matters.`,
    ...(generate.length > 0 ? [`New images from text, with ${GENERATE_TOOL}:`, ...generate] : []),
    ...(edit.length > 0 ? [`Changing or combining existing images, with ${EDIT_TOOL}:`, ...edit] : []),
    ...(models.length === 0 ? [`No supported model matches. Families: ${FAMILIES.join(", ")}.`] : []),
    `Call ${MODELS_TOOL} with model set to an exact ID for its control values, limits and argument schema.`,
  ].join("\n")
}

const modelsSchema = z
  .strictObject({
    operation: z
      .enum(["generate", "edit"])
      .nullish()
      .describe(`generate lists models for ${GENERATE_TOOL}; edit lists models for ${EDIT_TOOL}.`),
    family: z.enum(nonEmpty(FAMILIES)).nullish().describe("Limit the list to one model family."),
    query: z
      .string()
      .min(1)
      .nullish()
      .describe(
        `Words that must all appear in a model's ID, name, family, purpose or control names (${CONTROL_NAMES.join(", ")}), for example transparent or typography.`,
      ),
    model: z
      .enum([...modelIds("generate"), ...modelIds("edit")])
      .nullish()
      .describe("An exact model ID, for its control values, limits and argument schema."),
  })
  .superRefine((args, ctx) => {
    if (args.model && (args.operation || args.family || args.query)) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "model cannot be combined with operation, family or query.",
      })
    }
  })

function answerModels(args: z.output<typeof modelsSchema>): string {
  if (args.model) {
    const model = MODELS.find((candidate) => candidate.id === args.model)
    if (model) return describeDetail(model)
  }
  const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const matches = MODELS.filter(
    (model) =>
      (!args.operation || model.operation === args.operation) &&
      (!args.family || model.family === args.family) &&
      terms.every((term) =>
        `${model.id} ${model.name} ${model.family} ${model.purpose} ${controlsOf(model)
          .map((c) => c.name)
          .join(" ")}`
          .toLowerCase()
          .includes(term),
      ),
  )
  return describeList(matches, MODELS.length)
}

const MODEL_CHOICE_GUIDANCE = [
  `Choose a model by the task: use the model the operator named when this tool supports it; otherwise pick the supported model that fits and give a short reason. Ask the operator only when required input is missing, or when the request conflicts with a model, capability, cost or requirement they gave. A model choice needs no approval of its own.`,
  `If the provider returns an error, read its message and code, correct only an input that is demonstrably wrong, and do not repeat an unchanged call. Do not retry authentication, balance or rate-limit errors, and never switch a requested model silently: report what blocked the work and ask the operator to decide.`,
].join(" ")

function modelMenu(operation: Operation): string {
  return MODELS.filter((model) => model.operation === operation)
    .map((model) => `${model.id} (${model.name})`)
    .join("; ")
}

const SKILL_SENTENCE = `Load the ${SKILL_NAME} skill before image work when it is available, permitted and not already loaded; the tool also works without it.`

export function describeNanoImageTool(operation: Operation, requires: string): string {
  return operation === "generate"
    ? [
        `Generate one new raster image from a text prompt through NanoGPT. To change or combine existing images use ${EDIT_TOOL} instead. ${SKILL_SENTENCE}`,
        requires,
        `Required model, one of: ${modelMenu("generate")}. Optional controls (resolution, aspect_ratio, quality, background, seed) each exist only for some models; ${MODELS_TOOL} lists them locally without a key, and an unsupported control or value is rejected before any request. Omitted controls are not sent, so NanoGPT's defaults apply. Exactly one image is requested; only PNG responses are saved.`,
        "Best for photos, illustrations, textures and concepts; build icons, logos, charts and anything that must scale or stay editable as SVG or code.",
        MODEL_CHOICE_GUIDANCE,
        "Returns the saved PNG's absolute path and actual pixel dimensions; the requested size is not enforced, so check the dimensions when they matter. Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
      ].join(" ")
    : [
        `Edit or combine existing local images into one new raster image through NanoGPT, guided by a prompt. To create an image from text alone use ${GENERATE_TOOL}. ${SKILL_SENTENCE}`,
        requires,
        `Required images (local PNG, JPEG or WebP paths) and model, one of: ${modelMenu("edit")}. The count limit depends on the model. Optional controls (resolution, aspect_ratio, quality, background, seed) each exist only for some models; ${MODELS_TOOL} lists them locally without a key, and an unsupported control or value is rejected before any request. Omitted controls are not sent. Exactly one image is requested; only PNG responses are saved.`,
        "The result is a newly generated image, so areas the prompt does not mention can change; use an image editor when pixels must stay identical. Name each reference's role in the prompt and what to keep.",
        MODEL_CHOICE_GUIDANCE,
        "Returns the saved PNG's absolute path and actual pixel dimensions. Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
      ].join(" ")
}

export const nanoModelsTool = defineInfoTool({
  name: MODELS_TOOL,
  description: [
    `List the NanoGPT image models this plugin supports, or describe one exactly. It answers from a table inside the plugin: no key, permission prompt, file access or network request, and no cost. Use it before choosing a model for ${GENERATE_TOOL} or ${EDIT_TOOL}.`,
    "Without model it lists the supported models, filtered by operation, family or query words; with an exact model ID it returns that model's purpose, control values, limits and argument schema. The table follows provider documentation and has not been validated with live calls.",
  ].join(" "),
  schema: modelsSchema,
  answer: answerModels,
})
