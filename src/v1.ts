import type { Hooks, Plugin, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { loadStoredCredential } from "./auth"
import { selectBackend } from "./backend"
import { describeImagegen, generateImage, IMAGEGEN_TOOL } from "./imagegen"
import { loadPackagedSkill, SKILLS_DIRECTORY } from "./skill"
import type { Backend } from "./types"

// A plain tool definition, so the module needs no runtime import from the OpenCode 1 SDK.
function createImagegenTool(backend: Backend) {
  const { credential } = backend
  return {
    description: describeImagegen(backend),
    args: backend.argsSchema.shape,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const saved = await generateImage(rawArgs, backend, {
        signal: ctx.abort,
        // The host binds the session, agent and tool call to this request. The resource is the backend id, so a
        // grant saved for one backend does not cover another.
        authorize: (args) =>
          ctx.ask({ permission: IMAGEGEN_TOOL, patterns: [backend.id], always: [backend.id], metadata: { ...args } }),
        resolveDirectory: async () => ctx.directory,
        resolveCredential: async () => {
          const stored = await loadStoredCredential(credential)
          if (!stored) {
            throw new Error(
              `${credential.label} credentials not configured. Run \`opencode auth login --provider ${credential.provider}\`.`,
            )
          }
          return stored
        },
      })
      return { output: saved.message, metadata: { out: saved.savedPath, versioned: saved.versioned } }
    },
  }
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
// A key credential gets a native `auth` hook without a loader, so OpenCode can store the key under the backend's
// provider id; no provider or model is registered, which leaves chat model selection alone.
export const server: Plugin = async (_input, options): Promise<Hooks> => {
  const backend = selectBackend(options)
  // The host would skip an unreadable skill silently, so check the shipped file when the plugin loads.
  await loadPackagedSkill()
  const { credential } = backend
  return {
    config: async (config) => registerSkillsDirectory(config as SkillConfig),
    tool: { [IMAGEGEN_TOOL]: createImagegenTool(backend) as unknown as ToolDefinition },
    ...(credential.type === "key"
      ? { auth: { provider: credential.provider, methods: [{ type: "api" as const, label: credential.label }] } }
      : {}),
  }
}
