import type { Hooks, Plugin, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { generateImage, IMAGEGEN_DESCRIPTION, IMAGEGEN_TOOL } from "./imagegen"
import { argsShape } from "./schema"

// A plain tool definition, so the module needs no runtime import from the OpenCode 1 SDK.
const imagegenTool = {
  description: IMAGEGEN_DESCRIPTION,
  args: argsShape,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const saved = await generateImage(rawArgs, {
      signal: ctx.abort,
      // The host binds the session, agent and tool call to this request.
      authorize: (args) =>
        ctx.ask({ permission: IMAGEGEN_TOOL, patterns: ["*"], always: ["*"], metadata: { ...args } }),
      resolveDirectory: async () => ctx.directory,
      resolveAuth: async () => {
        const auth = await loadOpenAIAuth()
        if (!auth) {
          throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
        }
        return auth
      },
    })
    return { output: saved.message, metadata: { out: saved.savedPath, versioned: saved.versioned } }
  },
}

// OpenCode 1 entry point. The SDK types its own pinned Zod copy, which TypeScript treats as a different
// type from this package's Zod; the schemas are structurally the same and OpenCode 1 composes them at runtime.
export const server: Plugin = async (): Promise<Hooks> => ({
  tool: { [IMAGEGEN_TOOL]: imagegenTool as unknown as ToolDefinition },
})
