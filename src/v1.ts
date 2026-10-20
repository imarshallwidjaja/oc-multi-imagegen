import type { Hooks, Plugin, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { generateImage, IMAGEGEN_DESCRIPTION, IMAGEGEN_TOOL } from "./imagegen"
import { argsShape } from "./schema"
import { loadPackagedSkill, SKILLS_DIRECTORY } from "./skill"

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

// The published OpenCode 1 Config type omits `skills`, which the host reads at runtime.
type SkillConfig = { skills?: { paths?: string[]; urls?: string[] } }

// Adds the package's skills directory once, keeping the user's own paths and urls. The path is absolute
// because OpenCode 1 resolves relative skill paths against the project.
function registerSkillsDirectory(config: SkillConfig): void {
  const paths = config.skills?.paths ?? []
  if (paths.includes(SKILLS_DIRECTORY)) return
  config.skills = { ...config.skills, paths: [...paths, SKILLS_DIRECTORY] }
}

// OpenCode 1 entry point. The SDK types its own pinned Zod copy, which TypeScript treats as a different
// type from this package's Zod; the schemas are structurally the same and OpenCode 1 composes them at runtime.
export const server: Plugin = async (): Promise<Hooks> => {
  // The host would skip an unreadable skill silently, so check the shipped file when the plugin loads.
  await loadPackagedSkill()
  return {
    config: async (config) => registerSkillsDirectory(config as SkillConfig),
    tool: { [IMAGEGEN_TOOL]: imagegenTool as unknown as ToolDefinition },
  }
}
