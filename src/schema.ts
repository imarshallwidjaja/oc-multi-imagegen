import { z } from "zod"
import { IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"

// The single definition of the imagegen arguments. OpenCode 1 takes the raw shape, OpenCode 2 takes the
// object schema, and execution parses raw input with the same schema.
export const argsShape = {
  prompt: z.string().describe("Description of the image to generate."),
  out: z
    .string()
    .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
  size: z
    .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]], {
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use one of: ${SIZE_CHOICES}.`
          : `Unsupported size "${issue.input}". Use one of: ${SIZE_CHOICES}.`,
    })
    .describe(`Output size. Supported sizes: ${SIZE_CHOICES}. Actual dimensions may differ by 1px.`),
  // Same limit as Codex (MAX_EDIT_IMAGES).
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L59
  images: z
    .array(z.string())
    .max(5)
    .nullish()
    .describe("Optional reference image paths, up to 5, relative to the project directory unless absolute."),
  background: z
    .enum(["opaque", "transparent"])
    .nullish()
    .describe("Optional background of the output image. Defaults to opaque."),
}

export const argsSchema = z.object(argsShape)

export type GenerateArgs = z.infer<typeof argsSchema>

// Structured result of a saved image. It matches the metadata both hosts report.
export const resultSchema = z.object({
  out: z.string().describe("Absolute path of the saved PNG."),
  versioned: z.boolean().describe("True when the requested path existed and a -vN suffix was used."),
})

// Hosts can call execute without validating arguments first, so execution parses them again.
export function parseArgs(raw: unknown): GenerateArgs {
  const parsed = argsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error))
  }
  return parsed.data
}
