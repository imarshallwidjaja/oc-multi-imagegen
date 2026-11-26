import { z } from "zod"
import { listFormatNames, type OutputFormat } from "./image-format"

// The public tool names. Every backend creates a new image from text with IMAGEGEN_TOOL and changes or combines
// existing images with IMAGEEDIT_TOOL; argument errors point from one to the other.
export const IMAGEGEN_TOOL = "imagegen"
export const IMAGEEDIT_TOOL = "imageedit"
// The model information tool of a backend that offers one: a local table on NanoGPT, a live provider list on the
// OpenAI Images API.
export const MODELS_TOOL = "imagegen_models"

export type Operation = "generate" | "edit"
export const TOOL_OF: Record<Operation, string> = { generate: IMAGEGEN_TOOL, edit: IMAGEEDIT_TOOL }

export const PROMPT_DESCRIPTION: Record<Operation, string> = {
  generate: "Description of the image to generate. Put every visible string in quotes.",
  edit: "The edit to make, in natural language. Name each reference image's role (Image 1, Image 2, in the order of images) and what to keep. Put every visible string in quotes.",
}

export const NO_REFERENCES = `${IMAGEEDIT_TOOL} needs at least one reference image. Use ${IMAGEGEN_TOOL} to create an image from text.`

// The arguments of the generation tool that belong to the edit tool, with what to do instead. A generation tool
// refuses them instead of dropping them, so a call with references never silently becomes a different image.
export const GENERATION_MOVED_ARGUMENTS: Readonly<Record<string, string>> = {
  images: `${IMAGEGEN_TOOL} creates a new image from text; use ${IMAGEEDIT_TOOL} to change or combine existing images.`,
}

// Where reference images can come from, for the `images` description of every edit tool.
export const REFERENCE_ENTRIES =
  "local paths (relative to the project directory unless absolute) or https URLs, each fetched after a webfetch permission and at most 20 MiB"

// The opt-in inline preview every image tool takes. It changes only how the result is returned, never the request.
export const previewField = () =>
  z
    .boolean()
    .nullish()
    .describe(
      "Optional inline image preview on OpenCode 2; defaults to false. When true, attaches the saved PNG, JPEG or WebP (up to 3.5 MiB) directly to the tool response. Leave false for batches.",
    )

// The destination argument of an image tool, naming the formats it saves: pass the same list as the tool's
// `outputFormats`.
export function outField(outputFormats: readonly OutputFormat[]) {
  return z
    .string()
    .describe(
      `Destination path, relative to the project directory unless absolute. Saves native ${listFormatNames(outputFormats)} bytes without conversion, adjusting the extension to match. An existing file, even one a concurrent call created first, is kept and the image gets the first free -vN suffix, up to -v999.`,
    )
}

// The error for the arguments a strict tool schema does not define. `moved` names, for an argument that belongs to
// another tool, what to do instead; any other argument is answered with the list the tool accepts.
function unrecognizedArguments(tool: string, accepted: readonly string[], moved: Readonly<Record<string, string>>) {
  return (issue: z.core.$ZodRawIssue) => {
    if (issue.code !== "unrecognized_keys") return undefined
    const names = issue.keys.join(", ")
    const advice = issue.keys.map((key) => moved[key]).find(Boolean) ?? `${tool} accepts: ${accepted.join(", ")}.`
    return `Unsupported argument${issue.keys.length === 1 ? "" : "s"}: ${names}. ${advice}`
  }
}

// Every image tool rejects arguments it does not define, so the host's own validation refuses them too, before the
// tool runs.
export function strictArgs<T extends z.core.$ZodLooseShape>(
  tool: string,
  shape: T,
  moved: Readonly<Record<string, string>> = {},
) {
  return z.strictObject(shape, { error: unrecognizedArguments(tool, Object.keys(shape), moved) })
}

// What the Codex and OpenAI Images API backends decide about the arguments both their image tools share: how size is
// chosen, the guidance for the fields whose behavior depends on the provider, and the formats the tool saves.
export type ArgsSpec = {
  size: z.ZodType<string>
  model: string
  quality: string
  // The formats the tool saves, which `out` describes; the tool declares the same list as its `outputFormats`.
  outputFormats: readonly OutputFormat[]
  // Guidance for `background`; omitted, the opaque-default guidance shared by Codex and the OpenAI Images API.
  background?: string
}

export type EditArgsSpec = ArgsSpec & { maxImages: number; imagesNote?: string }

function controlFields(spec: ArgsSpec) {
  return {
    background: z
      .enum(["opaque", "transparent"])
      .nullish()
      .describe(
        spec.background ??
          "Optional background; defaults to opaque. Use transparent for a cut-out instead of asking for one in the prompt. The returned alpha can be soft; the tool reports measured PNG alpha (or WebP header flags) without modifying pixels.",
      ),
    model: z.string().min(1).nullish().describe(spec.model),
    quality: z.string().min(1).nullish().describe(spec.quality),
    preview: previewField(),
  }
}

// The imagegen arguments of the Codex and OpenAI Images API backends: text only. OpenCode 1 takes the raw shape,
// OpenCode 2 takes the object schema, and execution parses raw input with the same schema.
export function generationShape(spec: ArgsSpec) {
  return {
    prompt: z.string().describe(PROMPT_DESCRIPTION.generate),
    out: outField(spec.outputFormats),
    size: spec.size,
    ...controlFields(spec),
  }
}

// The imageedit arguments of the Codex and OpenAI Images API backends: the generation arguments with a required,
// nonempty list of reference images.
export function editShape(spec: EditArgsSpec) {
  return {
    prompt: z.string().describe(PROMPT_DESCRIPTION.edit),
    out: outField(spec.outputFormats),
    size: spec.size,
    images: z
      .array(z.string().min(1), {
        error: (issue) => (issue.input == null ? `Missing images. ${NO_REFERENCES}` : undefined),
      })
      .min(1, NO_REFERENCES)
      .max(spec.maxImages, `${IMAGEEDIT_TOOL} takes at most ${spec.maxImages} reference images.`)
      .describe(
        [
          `Required reference images, 1 to ${spec.maxImages}: ${REFERENCE_ENTRIES}. They are sent in order, so call them Image 1, Image 2 in the prompt.`,
          spec.imagesNote,
          "Their contents are uploaded to the provider.",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ...controlFields(spec),
  }
}

// Structured result of a saved image on OpenCode 2: the { out, versioned } metadata both hosts report, plus the report
// text. Code Mode returns only this output when a tool declares one, so the report must be part of it.
export const resultSchema = z.object({
  out: z.string().describe("Actual absolute path of the saved image file. Use this path for reads or edits."),
  versioned: z
    .boolean()
    .describe("True only when the format-adjusted target existed and a -vN collision suffix was used."),
  message: z
    .string()
    .describe(
      "Human-readable report with the saved path, format, dimensions and any requested-vs-verified settings note.",
    ),
})

// Hosts can call execute without validating arguments first, so execution parses them again with the complete schema.
export function parseArgs<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error))
  }
  return parsed.data
}
