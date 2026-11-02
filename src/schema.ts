import { z } from "zod"

// What a backend decides about the arguments: how size is chosen, how many references it takes, and the guidance
// for the fields whose behavior depends on the provider.
export type ArgsSpec = {
  size: z.ZodType<string>
  maxImages: number
  imagesNote?: string
  model: string
  quality: string
}

// The imagegen arguments of the Codex and OpenAI Images API backends. OpenCode 1 takes the raw shape, OpenCode 2
// takes the object schema, and execution parses raw input with the same schema.
export function createArgsShape(spec: ArgsSpec) {
  return {
    prompt: z
      .string()
      .describe(
        "Description of the image to generate, or of the edit to make when images are given. Put every visible string in quotes, and name each reference image's role when images are given.",
      ),
    out: z
      .string()
      .describe(
        "Destination path, relative to the project directory unless absolute. Saves native PNG, JPEG or WebP bytes without conversion, adjusting the extension to match. An existing target is kept and the new image gets a -vN suffix. Use the returned out path for subsequent reads or edits.",
      ),
    size: spec.size,
    images: z
      .array(z.string())
      .max(spec.maxImages)
      .nullish()
      .describe(
        [
          `Optional local reference image paths, up to ${spec.maxImages}, relative to the project directory unless absolute; they are sent in order, so call them Image 1, Image 2 in the prompt.`,
          spec.imagesNote,
          "Their contents are uploaded to the provider, and a nonempty list makes the call a generative edit: areas the prompt does not mention can still change, so pixel-exact edits belong in an image editor.",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    background: z
      .enum(["opaque", "transparent"])
      .nullish()
      .describe(
        "Optional background requested from the backend; defaults to opaque. Use transparent for a cut-out instead of asking for one in the prompt. The returned alpha can be soft, and the tool does not check or clean it up.",
      ),
    model: z.string().min(1).nullish().describe(spec.model),
    quality: z.string().min(1).nullish().describe(spec.quality),
  }
}

export type ArgsShape = ReturnType<typeof createArgsShape>

export type GenerateArgs = z.infer<z.ZodObject<ArgsShape>>

// Structured result of a saved image. It matches the metadata both hosts report.
export const resultSchema = z.object({
  out: z.string().describe("Actual absolute path of the saved PNG, JPEG or WebP. Use this path for reads or edits."),
  versioned: z
    .boolean()
    .describe("True only when the format-adjusted target existed and a -vN collision suffix was used."),
})

// Hosts can call execute without validating arguments first, so execution parses them again with the complete schema.
export function parseArgs<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error))
  }
  return parsed.data
}
