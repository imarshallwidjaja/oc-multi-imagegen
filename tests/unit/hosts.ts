import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import type { argsSchema, resultSchema } from "../../src/schema"

// Test doubles for the two host contracts. They stand in for OpenCode 1's ToolContext and
// OpenCode 2's plugin Context; the adapters under test never import either SDK at runtime.

export type NormalizedResult = { message: string; out: string; versioned: boolean }

export type ToolHarness = {
  // Every permission request the adapter made, in the host's own request shape.
  permissionRequests: unknown[]
  // Makes the next permission requests fail as a host denial would.
  denyPermission: (error: Error) => void
  execute: (rawArgs: unknown, signal?: AbortSignal) => Promise<NormalizedResult>
}

const SESSION_ID = "ses_test"

// The tool definition OpenCode 2 receives from the adapter, as far as the tests inspect it.
export type RegisteredTool = {
  name: string
  description: string
  options: Record<string, unknown>
  input: typeof argsSchema
  output: typeof resultSchema
  execute: (
    input: unknown,
    context: ReturnType<typeof v2ToolContext>,
  ) => Promise<{
    output: { out: string; versioned: boolean }
    content: string
    metadata: { out: string; versioned: boolean }
  }>
}

export type V2Options = {
  // Directory returned for any session; override per call with sessionDirectories.
  directory?: string
  sessionDirectories?: Record<string, string>
  connection?: unknown
  credential?: unknown
  activeError?: Error
  resolveError?: Error
}

export const CHATGPT_BROWSER_CREDENTIAL = {
  type: "oauth",
  methodID: "chatgpt-browser",
  refresh: "refresh",
  access: "tok",
  expires: Number.MAX_SAFE_INTEGER,
}

export function createV2Context(options: V2Options = {}) {
  const calls = {
    assert: [] as Array<Record<string, unknown>>,
    sessionGet: [] as Array<{ sessionID: string }>,
    active: [] as string[],
    resolve: [] as unknown[],
  }
  const registered: RegisteredTool[] = []
  let denial: Error | undefined
  const context = {
    // A directory the adapter must not use: sessions carry their own location.
    location: { directory: "/plugin-load-directory" },
    tool: {
      transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        callback({ add: (tool) => registered.push(tool) })
        return { dispose: async () => {} }
      },
    },
    permission: {
      assert: async (input: Record<string, unknown>) => {
        calls.assert.push(input)
        if (denial) throw denial
      },
    },
    session: {
      get: async (input: { sessionID: string }) => {
        calls.sessionGet.push(input)
        return { location: { directory: options.sessionDirectories?.[input.sessionID] ?? options.directory } }
      },
    },
    integration: {
      connection: {
        active: async (integrationID: string) => {
          calls.active.push(integrationID)
          if (options.activeError) throw options.activeError
          return "connection" in options ? options.connection : { type: "credential", id: "cred_1", method: "oauth" }
        },
        resolve: async (connection: unknown) => {
          calls.resolve.push(connection)
          if (options.resolveError) throw options.resolveError
          return "credential" in options ? options.credential : CHATGPT_BROWSER_CREDENTIAL
        },
      },
    },
  }
  return {
    context: context as unknown as Plugin.Context,
    calls,
    registered,
    denyPermission: (error: Error) => {
      denial = error
    },
  }
}

export function v2ToolContext(signal: AbortSignal, sessionID = SESSION_ID) {
  return { sessionID, agent: "build", messageID: "msg_test", id: "call_test", signal, progress: async () => {} }
}

export async function loadV2Tool(options: V2Options = {}) {
  const fake = createV2Context(options)
  await plugin.setup(fake.context)
  const tool = fake.registered[0]
  return {
    ...fake,
    tool,
    run: (rawArgs: unknown, signal = new AbortController().signal, sessionID?: string) =>
      tool.execute(rawArgs, v2ToolContext(signal, sessionID)),
  }
}

export function v1ToolContext(directory: string, signal: AbortSignal, ask: ToolContext["ask"]): ToolContext {
  return { directory, abort: signal, ask } as unknown as ToolContext
}

export async function v1Harness(directory: string): Promise<ToolHarness> {
  const hooks = await plugin.server({} as never)
  const tool = hooks.tool?.imagegen
  if (!tool) throw new Error("imagegen is not registered")
  const permissionRequests: unknown[] = []
  let denial: Error | undefined
  const ask: ToolContext["ask"] = async (input) => {
    permissionRequests.push(input)
    if (denial) throw denial
  }
  return {
    permissionRequests,
    denyPermission: (error) => {
      denial = error
    },
    async execute(rawArgs, signal = new AbortController().signal) {
      const result = (await tool.execute(rawArgs as never, v1ToolContext(directory, signal, ask))) as {
        output: string
        metadata: { out: string; versioned: boolean }
      }
      return { message: result.output, out: result.metadata.out, versioned: result.metadata.versioned }
    },
  }
}

export async function v2Harness(directory: string): Promise<ToolHarness> {
  const loaded = await loadV2Tool({ directory })
  return {
    permissionRequests: loaded.calls.assert,
    denyPermission: loaded.denyPermission,
    async execute(rawArgs, signal) {
      const result = await loaded.run(rawArgs, signal)
      return { message: result.content, out: result.output.out, versioned: result.output.versioned }
    },
  }
}
