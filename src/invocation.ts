import type { BackendTool, ProviderAccess } from "./types"

// What a host adapter can supply for one call. Each is asked for only when the tool needs it: an information tool
// uses neither, and a lookup needs no session directory.
export type HostCapabilities = {
  providerAccess: () => ProviderAccess
  resolveDirectory: () => Promise<string>
}

// The result a host reports: the text for the agent and, for a tool that saved an image, its public metadata.
export type InvocationResult = { text: string; image?: { out: string; versioned: boolean } }

// Runs one call of any tool kind the same way on every host; each host shapes the result for its own API.
export async function invokeTool(
  tool: BackendTool,
  rawArgs: unknown,
  host: HostCapabilities,
): Promise<InvocationResult> {
  switch (tool.kind) {
    case "info":
      return { text: tool.run(rawArgs) }
    case "lookup":
      return { text: await tool.run(rawArgs, host.providerAccess()) }
    case "image": {
      const saved = await tool.run(rawArgs, { ...host.providerAccess(), resolveDirectory: host.resolveDirectory })
      return { text: saved.message, image: { out: saved.savedPath, versioned: saved.versioned } }
    }
  }
}
