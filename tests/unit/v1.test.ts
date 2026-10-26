import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { selectBackend } from "../../src/backend"
import plugin from "../../src/index"
import { SKILLS_DIRECTORY } from "../../src/skill"
import { isolateEnvironment, PNG_BASE64, PNG_BUFFER } from "./fixtures"
import {
  type Backend,
  ENVIRONMENT_KEY,
  FLAVOURS,
  type Flavour,
  SHARED_SIZE,
  STORED_CREDENTIALS,
  selectBackendVariable,
  v1ToolContext,
} from "./hosts"

isolateEnvironment()
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    ...STORED_CREDENTIALS,
    openai: { ...STORED_CREDENTIALS.openai, accountId: "acct-1" },
  })
  dir = await mkdtemp(path.join(os.tmpdir(), "v1-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

function stubFetch() {
  const fetchMock = mock(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

// Pass a config to run the plugin's config hook on it before the tool is used, as the host does at startup.
async function loadTool(config?: Record<string, unknown>, backend?: Backend, name = "imagegen") {
  selectBackendVariable(backend)
  const hooks = config ? await runConfigHook(config) : await plugin.server({} as never)
  const tool = hooks.tool?.[name]
  if (!tool) throw new Error(`${name} is not registered`)
  return tool
}

function recordAsks() {
  const asks: Array<Parameters<ToolContext["ask"]>[0]> = []
  const ask: ToolContext["ask"] = async (input) => {
    asks.push(input)
  }
  return { asks, ask }
}

// The hook's parameter is the SDK Config, which omits the `skills` key the host reads at runtime.
async function runConfigHook(config: Record<string, unknown>) {
  const hooks = await plugin.server({} as never)
  await hooks.config?.(config as never)
  return hooks
}

describe("OpenCode 1 skill registration", () => {
  test("adds the absolute packaged skills directory to a config without skills", async () => {
    const config: Record<string, unknown> = {}

    await runConfigHook(config)

    expect(config).toEqual({ skills: { paths: [SKILLS_DIRECTORY] } })
    expect(path.isAbsolute(SKILLS_DIRECTORY)).toBe(true)
  })

  test("keeps the user's skill paths and urls and adds the directory once across repeated runs", async () => {
    const config = {
      skills: { paths: ["./team-skills", "~/skills"], urls: ["https://example.com/.well-known/skills/"] },
    }

    await runConfigHook(config)
    await runConfigHook(config)

    expect(config).toEqual({
      skills: {
        paths: ["./team-skills", "~/skills", SKILLS_DIRECTORY],
        urls: ["https://example.com/.well-known/skills/"],
      },
    })
  })

  test("leaves other configuration alone", async () => {
    const config: Record<string, unknown> = {
      model: "openai/example",
      skills: { urls: ["https://example.com/skills/"] },
    }

    await runConfigHook(config)

    expect(config).toEqual({
      model: "openai/example",
      skills: { urls: ["https://example.com/skills/"], paths: [SKILLS_DIRECTORY] },
    })
  })
})

const LEGACY_ARGUMENTS = ["prompt", "out", "size", "images", "background", "model", "quality"]
const NANO_ARGUMENTS = ["model", "prompt", "out", "resolution", "aspect_ratio", "quality", "background", "seed"]
const legacyFlavours = FLAVOURS.filter((flavour) => flavour.backend !== "nano-gpt")
const keyFlavours = FLAVOURS.filter((flavour) => flavour.key)
const operationRows = FLAVOURS.flatMap((flavour) =>
  flavour.operations.map((operation) => [flavour.backend, operation.tool, flavour, operation] as const),
)
const args = { prompt: "a cat", out: "cat.png", size: SHARED_SIZE }

describe("OpenCode 1 adapter", () => {
  test.each(legacyFlavours)(
    "registers one imagegen tool with the documented arguments for $backend",
    async (flavour) => {
      selectBackendVariable(flavour.backend)
      const hooks = await plugin.server({} as never)

      expect(Object.keys(hooks.tool ?? {})).toEqual(["imagegen"])
      expect(Object.keys((await loadTool(undefined, flavour.backend)).args)).toEqual(LEGACY_ARGUMENTS)
    },
  )

  test("registers the NanoGPT generation, editing and model information tools", async () => {
    selectBackendVariable("nano-gpt")
    const hooks = await plugin.server({} as never)

    expect(Object.keys(hooks.tool ?? {})).toEqual(["imagegen", "imageedit", "imagegen_models"])
    expect(Object.keys(hooks.tool?.imagegen.args ?? {})).toEqual(NANO_ARGUMENTS)
    expect(Object.keys(hooks.tool?.imageedit.args ?? {})).toEqual([...NANO_ARGUMENTS, "images"])
    expect(Object.keys(hooks.tool?.imagegen_models.args ?? {})).toEqual(["operation", "family", "query", "model"])
  })

  test.each(FLAVOURS)("exposes the $backend descriptions and a description for every argument", async (flavour) => {
    selectBackendVariable(flavour.backend)
    const hooks = await plugin.server({} as never)

    for (const declared of selectBackend(undefined).tools) {
      const tool = hooks.tool?.[declared.name]
      expect(tool?.description).toBe(declared.description)
      for (const arg of Object.values(tool?.args ?? {})) {
        // The SDK types args with its own Zod core type, which does not declare the description getter.
        expect((arg as { description?: string }).description).toEqual(expect.stringMatching(/\S/))
      }
    }
  })

  test("returns the saved path as output text and { out, versioned } metadata", async () => {
    stubFetch()
    const tool = await loadTool()
    const { ask } = recordAsks()
    const ctx = v1ToolContext(dir, new AbortController().signal, ask)

    const result = await tool.execute({ ...args, size: "1672x941" }, ctx)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    expect(result).toEqual({
      output: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
  })

  test.each(operationRows)(
    "asks only for the permission named like the %s tool (%s) on the backend's resource",
    async (_backend, name, flavour, operation) => {
      stubFetch()
      await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
      const tool = await loadTool({}, flavour.backend, name)
      const { asks, ask } = recordAsks()

      await tool.execute(operation.args, v1ToolContext(dir, new AbortController().signal, ask))

      expect(asks).toEqual([
        { permission: name, patterns: [flavour.resource], always: [flavour.resource], metadata: operation.args },
      ])
    },
  )

  test("sends the account from OpenCode's auth data as the ChatGPT account header", async () => {
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const { ask } = recordAsks()

    await tool.execute(args, v1ToolContext(dir, new AbortController().signal, ask))

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-1")
  })

  test.each(operationRows)(
    "reports missing credentials of the %s backend for %s after the permission and before the backend call",
    async (_backend, name, flavour, operation) => {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
      const fetchMock = stubFetch()
      const tool = await loadTool(undefined, flavour.backend, name)
      const { asks, ask } = recordAsks()

      const act = tool.execute(operation.args, v1ToolContext(dir, new AbortController().signal, ask))

      await expect(act).rejects.toThrow(`credentials not configured.`)
      await expect(act).rejects.toThrow(`\`opencode auth login --provider ${flavour.provider}\``)
      expect(asks).toHaveLength(1)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("does not read credentials when the permission is denied", async () => {
    // Reaching the credential loader would report missing credentials instead of the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const ask: ToolContext["ask"] = async () => {
      throw new Error("denied by the host")
    }

    const act = tool.execute(args, v1ToolContext(dir, new AbortController().signal, ask))

    await expect(act).rejects.toThrow("denied by the host")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe.each(keyFlavours)("OpenCode 1 image API key of the $backend backend", (flavour) => {
  const { variable, saved, label } = flavour.key as NonNullable<Flavour["key"]>
  const operation = flavour.operations[0]
  const authorizations = (fetchMock: ReturnType<typeof stubFetch>) =>
    fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)

  test(`registers the ${flavour.provider} sign-in as a native api method with no loader or provider entry`, async () => {
    selectBackendVariable(flavour.backend)
    const hooks = await plugin.server({} as never)
    const config: Record<string, unknown> = { model: "openai/example" }
    await hooks.config?.(config as never)

    expect(hooks.auth).toEqual({ provider: flavour.provider, methods: [{ type: "api", label }] })
    // A provider or model entry would take part in OpenCode's default chat model choice.
    expect(hooks.provider).toBeUndefined()
    expect(config).not.toHaveProperty("provider")
  })

  test("authenticates with the saved key from OpenCode's auth data, read on every call", async () => {
    const fetchMock = stubFetch()
    const tool = await loadTool(undefined, flavour.backend)
    const { ask } = recordAsks()
    const context = v1ToolContext(dir, new AbortController().signal, ask)

    await tool.execute(operation.args, context)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ [flavour.provider]: { type: "api", key: "sk-rotated" } })
    await tool.execute({ ...operation.args, out: "second.png" }, context)

    expect(authorizations(fetchMock)).toEqual([`Bearer ${saved}`, "Bearer sk-rotated"])
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers).not.toHaveProperty("ChatGPT-Account-Id")
  })

  test(`reads the key from ${variable} itself, since OpenCode 1 has no resolver for it`, async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    process.env[variable] = ENVIRONMENT_KEY
    const fetchMock = stubFetch()
    const tool = await loadTool(undefined, flavour.backend)
    const { ask } = recordAsks()

    await tool.execute(operation.args, v1ToolContext(dir, new AbortController().signal, ask))

    expect(authorizations(fetchMock)).toEqual([`Bearer ${ENVIRONMENT_KEY}`])
  })

  test("names the variable and the sign-in command when neither holds a key", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    const tool = await loadTool(undefined, flavour.backend)
    const { ask } = recordAsks()

    const act = tool.execute(operation.args, v1ToolContext(dir, new AbortController().signal, ask))

    await expect(act).rejects.toThrow(
      `${label} credentials not configured. Set ${variable} in the environment of the OpenCode process, or run \`opencode auth login --provider ${flavour.provider}\`.`,
    )
  })

  test("never uses the OpenAI chat sign-in or another backend's key", async () => {
    const others = Object.fromEntries(
      Object.entries(STORED_CREDENTIALS).filter(([provider]) => provider !== flavour.provider),
    )
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(others)
    const fetchMock = stubFetch()
    const tool = await loadTool(undefined, flavour.backend)
    const { ask } = recordAsks()

    const act = tool.execute(operation.args, v1ToolContext(dir, new AbortController().signal, ask))

    await expect(act).rejects.toThrow(`${label} credentials not configured.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("OpenCode 1 Codex credentials", () => {
  test("registers no sign-in for the Codex backend, whose OpenAI sign-in belongs to the host", async () => {
    const hooks = await plugin.server({} as never)

    expect(hooks.auth).toBeUndefined()
  })

  test("never uses an image key", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "openai-images": { type: "api", key: "sk-images" },
      "nano-gpt-images": { type: "api", key: "sk-nano" },
    })
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const { ask } = recordAsks()

    const act = tool.execute(args, v1ToolContext(dir, new AbortController().signal, ask))

    await expect(act).rejects.toThrow("OpenAI ChatGPT OAuth credentials not configured.")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
