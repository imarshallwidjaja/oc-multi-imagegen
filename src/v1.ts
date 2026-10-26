import type { Hooks, Plugin, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { loadCredential } from "./auth"
import { selectBackend } from "./backend"
import { loadPackagedSkill, SKILLS_DIRECTORY } from "./skill"
import type { Backend, BackendTool } from "./types"

// A plain tool definition, so the module needs no runtime import from the OpenCode 1 SDK.
function createTool(backend: Backend, tool: BackendTool) {
  const { credential } = backend
  const definition = { description: tool.description, args: tool.schema.shape }
  if (tool.kind === "info") {
    return { ...definition, execute: async (rawArgs: unknown): Promise<ToolResult> => ({ output: tool.run(rawArgs) }) }
  }
  return {
    ...definition,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const saved = await tool.run(rawArgs, {
        signal: ctx.abort,
        // The host binds the session, agent and tool call to this request. The action is the tool's name and the
        // resource is the backend id, so a grant saved for one backend does not cover another.
        authorize: (action, args) =>
          ctx.ask({ permission: action, patterns: [backend.id], always: [backend.id], metadata: args }),
        resolveDirectory: async () => ctx.directory,
        resolveCredential: async () => {
          const loaded = await loadCredential(credential)
          if (!loaded) {
            const login = `opencode auth login --provider ${credential.provider}`
            const action =
              credential.type === "key"
                ? `Set ${credential.environmentVariable} in the environment of the OpenCode process, or run \`${login}\`.`
                : `Run \`${login}\`.`
            throw new Error(`${credential.label} credentials not configured. ${action}`)
          }
          return loaded
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
// provider id; no provider or model is registered, which leaves chat model selection alone. The backend comes from
// the OpenCode process environment (see selectBackend), so the plugin entry takes no options.
export const server: Plugin = async (_input, options): Promise<Hooks> => {
  const backend = selectBackend(options)
  // The host would skip an unreadable skill silently, so check the shipped file when the plugin loads.
  await loadPackagedSkill()
  const { credential } = backend
  return {
    config: async (config) => registerSkillsDirectory(config as SkillConfig),
    tool: Object.fromEntries(
      backend.tools.map((tool) => [tool.name, createTool(backend, tool) as unknown as ToolDefinition]),
    ),
    ...(credential.type === "key"
      ? { auth: { provider: credential.provider, methods: [{ type: "api" as const, label: credential.label }] } }
      : {}),
  }
}
