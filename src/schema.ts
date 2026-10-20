import { z } from "zod"
import { IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"

// The single definition of the imagegen arguments. OpenCode 1 takes the raw shape, OpenCode 2 takes the
// object schema, and execution parses raw input with the same schema.
export const argsShape = {
  prompt: z.string().describe("Description of the image to generate, or of the edit to make when images are given."),
  out: z
    .string()
    .describe(
      "Destination path, relative to the project directory unless absolute. The file always contains the backend's PNG bytes; the extension does not select or convert the format. An existing file is kept and the new image gets a -vN suffix.",
    ),
  size: z
    .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]], {
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use one of: ${SIZE_CHOICES}.`
          : `Unsupported size "${issue.input}". Use one of: ${SIZE_CHOICES}.`,
    })
    .describe(
      "Requested width x height preset. The tool asks for it in the prompt and does not resize the result; the result reports the actual pixel dimensions.",
    ),
  // Same limit as Codex (MAX_EDIT_IMAGES).
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L59
  images: z
    .array(z.string())
    .max(5)
    .nullish()
    .describe(
      "Optional local reference image paths, up to 5, relative to the project directory unless absolute. Their contents are uploaded to the provider, and a nonempty list makes the call a generative edit: areas the prompt does not mention can still change.",
    ),
  background: z
    .enum(["opaque", "transparent"])
    .nullish()
    .describe(
      "Optional background requested from the backend; defaults to opaque. The tool does not check or clean up the returned alpha channel.",
    ),
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
