import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { callViaCodexImages } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import { IMAGE_SIZES, type ImageSize, SIZE_CHOICES } from "./size"

const argsShape = {
  prompt: tool.schema.string().describe("Description of the image to generate."),
  out: tool.schema
    .string()
    .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
  size: tool.schema
    .enum(Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]], {
      error: (issue) =>
        issue.input == null
          ? `Missing size. Use one of: ${SIZE_CHOICES}.`
          : `Unsupported size "${issue.input}". Use one of: ${SIZE_CHOICES}.`,
    })
    .describe(`Output size. Supported sizes: ${SIZE_CHOICES}. Actual dimensions may differ by 1px.`),
  // Same limit as Codex (MAX_EDIT_IMAGES).
  // https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L59
  images: tool.schema
    .array(tool.schema.string())
    .max(5)
    .nullish()
    .describe("Optional reference image paths, up to 5, relative to the project directory unless absolute."),
  background: tool.schema
    .enum(["opaque", "transparent"])
    .nullish()
    .describe("Optional background of the output image. Defaults to opaque."),
}

// Some OpenCode versions do not validate plugin tool arguments before calling execute,
// so execute validates them against the same schema.
const argsSchema = tool.schema.object(argsShape)

const ImagegenPlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    tool: {
      imagegen: tool({
        description: [
          "Generate or edit one raster image through the ChatGPT Codex image backend.",
          "Requires OpenCode ChatGPT OAuth authentication. Optional reference images are sent to the provider.",
          "Returns the saved PNG's absolute path and actual pixel dimensions.",
          "Existing output paths are versioned on a best-effort basis; concurrent writes are not protected.",
        ].join(" "),
        args: argsShape,
        async execute(rawArgs, ctx) {
          const parsed = argsSchema.safeParse(rawArgs)
          if (!parsed.success) {
            throw new Error(tool.schema.prettifyError(parsed.error))
          }
          const args = parsed.data
          const auth = await loadOpenAIAuth()
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory)
          const base64 = await callViaCodexImages(auth, args, inputImageDataUrls)

          const { savedPath, versioned, message } = await saveGeneratedImage(args.out, ctx.directory, base64)

          return {
            output: message,
            metadata: {
              out: savedPath,
              versioned,
            },
          }
        },
      }),
    },
  }
}

export default {
  id: "oc-multi-imagegen",
  server: ImagegenPlugin,
} satisfies PluginModule
