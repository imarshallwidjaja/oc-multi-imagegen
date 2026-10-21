import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { selectBackend } from "../../src/backend"
import { describeImagegen } from "../../src/imagegen"
import { loadPackagedSkill, SKILL_FILE } from "../../src/skill"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"
import { CHATGPT_BROWSER_CREDENTIAL, FLAVOURS, loadV2Tool, SHARED_SIZE } from "./hosts"

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  // A valid OpenCode 1 credential must never be used by the OpenCode 2 adapter.
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: "oauth", access: "legacy-token" },
    "openai-images": { type: "api", key: "legacy-images-key" },
  })
  dir = await mkdtemp(path.join(os.tmpdir(), "v2-"))
})

afterEach(async () => {
  if (ORIGINAL_AUTH_CONTENT === undefined) {
    delete process.env.OPENCODE_AUTH_CONTENT
  } else {
    process.env.OPENCODE_AUTH_CONTENT = ORIGINAL_AUTH_CONTENT
  }
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

const args = { prompt: "a cat", out: "cat.png", size: SHARED_SIZE } as const
const API_OPTIONS = { backend: "openai-api" }

describe("OpenCode 2 tool registration", () => {
  test("registers imagegen as a direct tool without a namespace", async () => {
    const { registered, tool } = await loadV2Tool({ directory: dir })

    expect(registered).toHaveLength(1)
    expect(tool.name).toBe("imagegen")
    // Direct tools run without the execute tool; a permission override would hide the tool under its own name.
    expect(tool.options).toEqual({ codemode: false })
  })

  test("declares the input schema the model sees", async () => {
    const { tool } = await loadV2Tool({ directory: dir })

    const schema = z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as {
      required: string[]
      properties: Record<string, { enum?: string[]; description?: string }>
    }

    expect(tool.description).toBe(describeImagegen(selectBackend(undefined)))
    expect(Object.keys(schema.properties)).toEqual([
      "prompt",
      "out",
      "size",
      "images",
      "background",
      "model",
      "quality",
    ])
    for (const property of Object.values(schema.properties)) {
      expect(property.description).toEqual(expect.stringMatching(/\S/))
    }
    expect(schema.required).toEqual(["prompt", "out", "size"])
    expect(schema.properties.size.enum).toEqual([
      "1254x1254",
      "1536x1024",
      "1024x1536",
      "1448x1086",
      "1086x1448",
      "1672x941",
      "941x1672",
    ])
  })

  test("declares the structured output schema", async () => {
    const { tool } = await loadV2Tool({ directory: dir })

    const schema = z.toJSONSchema(tool.output, { target: "draft-2020-12", io: "output" }) as {
      required: string[]
      properties: Record<string, { type: string }>
    }

    expect(schema.required).toEqual(["out", "versioned"])
    expect(schema.properties.out.type).toBe("string")
    expect(schema.properties.versioned.type).toBe("boolean")
  })

  test("the host-validated input drops unknown keys and keeps null optional arguments", async () => {
    const { tool } = await loadV2Tool({ directory: dir })

    const result = await tool.input["~standard"].validate({
      ...args,
      n: 2,
      images: null,
      background: null,
      model: null,
    })

    expect(result).toEqual({ value: { ...args, images: null, background: null, model: null } })
  })

  test("replaying the registration produces the same definition", async () => {
    const first = await loadV2Tool({ directory: dir })
    const second = await loadV2Tool({ directory: dir })

    expect({ ...first.tool, execute: undefined }).toEqual({ ...second.tool, execute: undefined })
  })
})

describe("OpenCode 2 backend selection", () => {
  test.each(FLAVOURS)("registers the $backend schema and description from the plugin options", async (flavour) => {
    const { tool } = await loadV2Tool({ directory: dir, pluginOptions: flavour.options })

    expect(tool.description).toBe(describeImagegen(selectBackend(flavour.options)))
    expect(tool.input).toBe(selectBackend(flavour.options).argsSchema)
  })

  test("serves a different size contract for each backend", async () => {
    const codex = await loadV2Tool({ directory: dir })
    const api = await loadV2Tool({ directory: dir, pluginOptions: API_OPTIONS })
    const sizeOf = (tool: typeof codex.tool) =>
      (
        z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as unknown as {
          properties: { size: object }
        }
      ).properties.size

    expect(sizeOf(codex.tool)).toHaveProperty("enum")
    expect(sizeOf(api.tool)).not.toHaveProperty("enum")
  })

  test("fails the setup for invalid options, before registering anything", async () => {
    await expect(loadV2Tool({ directory: dir, pluginOptions: { backend: "dall-e" } })).rejects.toThrow(
      "Invalid oc-multi-imagegen options.",
    )
  })

  test("registers no integration for the Codex backend, whose OpenAI integration belongs to the host", async () => {
    const { integrations, integrationMethods } = await loadV2Tool({ directory: dir })

    expect([...integrations.keys()]).toEqual([])
    expect(integrationMethods).toEqual([])
  })

  test("registers openai-images as a key-only integration named OpenAI Images API", async () => {
    const { integrations, integrationMethods } = await loadV2Tool({ directory: dir, pluginOptions: API_OPTIONS })

    expect([...integrations.entries()]).toEqual([["openai-images", { name: "OpenAI Images API" }]])
    expect(integrationMethods).toEqual([{ integrationID: "openai-images", method: { type: "key" } }])
  })
})

describe("OpenCode 2 skill registration", () => {
  test("registers the packaged skill as an auto-invoked skill with its file path and body", async () => {
    const { skills } = await loadV2Tool({ directory: dir })
    const packaged = await loadPackagedSkill()

    expect([...skills.keys()]).toEqual(["oc-multi-imagegen"])
    expect(skills.get("oc-multi-imagegen")).toEqual({
      id: "oc-multi-imagegen",
      name: "oc-multi-imagegen",
      description: packaged.description,
      autoinvoke: true,
      path: SKILL_FILE,
      content: packaged.content,
    })
  })

  test("replaying the host's skill reload keeps one copy", async () => {
    const { replaySkills, skills } = await loadV2Tool({ directory: dir })
    const first = skills.get("oc-multi-imagegen")

    replaySkills()
    replaySkills()

    expect(skills.size).toBe(1)
    expect(skills.get("oc-multi-imagegen")).toBe(first)
  })

  test("leaves a skill with the same id that the host already holds", async () => {
    const existing = { id: "oc-multi-imagegen", name: "oc-multi-imagegen", content: "the user's own copy" }
    const { skills } = await loadV2Tool({ directory: dir, existingSkills: { "oc-multi-imagegen": existing } })

    expect(skills.get("oc-multi-imagegen")).toBe(existing)
  })

  test("registers the tool whether or not the host delivers skills", async () => {
    stubFetch()
    const { run, skills, tool } = await loadV2Tool({ directory: dir, skills: false })

    await run(args)

    expect(skills.size).toBe(0)
    expect(tool.name).toBe("imagegen")
  })
})

describe("OpenCode 2 execution", () => {
  test("returns structured output, the human message as content, and { out, versioned } metadata", async () => {
    stubFetch()
    const { run, tool } = await loadV2Tool({ directory: dir })

    const result = await run(args)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    expect(result).toEqual({
      output: { out: savedPath, versioned: false },
      content: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
    expect(tool.output.safeParse(result.output).success).toBe(true)
  })

  test("asks the host for the imagegen permission with the native call identity", async () => {
    stubFetch()
    const { calls, run } = await loadV2Tool({ directory: dir })

    await run({ ...args, background: "transparent" })

    expect(calls.assert).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        action: "imagegen",
        resources: ["codex"],
        save: ["codex"],
        metadata: { ...args, background: "transparent" },
        source: { type: "tool", messageID: "msg_test", id: "call_test" },
      },
    ])
  })

  test("asks for the openai-api resource when that backend is selected, so a Codex grant does not cover it", async () => {
    stubFetch()
    const { calls, run } = await loadV2Tool({ directory: dir, pluginOptions: API_OPTIONS })

    await run(args)

    expect(calls.assert.map(({ resources, save }) => ({ resources, save }))).toEqual([
      { resources: ["openai-api"], save: ["openai-api"] },
    ])
  })

  test("rethrows the host's denial before resolving credentials or reading the session, and the skill stays registered", async () => {
    const fetchMock = stubFetch()
    const { calls, denyPermission, run, skills } = await loadV2Tool({ directory: dir })
    const denial = new Error("denied by the host")
    denyPermission(denial)

    await expect(run(args)).rejects.toBe(denial)

    expect(calls.assert.map((request) => request.action)).toEqual(["imagegen"])
    expect(skills.has("oc-multi-imagegen")).toBe(true)
    expect(calls.active).toEqual([])
    expect(calls.resolve).toEqual([])
    expect(calls.sessionGet).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("resolves the directory from each call's session, not from where the plugin loaded", async () => {
    stubFetch()
    const other = await mkdtemp(path.join(os.tmpdir(), "v2-other-"))
    try {
      const { calls, run } = await loadV2Tool({ sessionDirectories: { ses_a: dir, ses_b: other } })

      const first = await run(args, undefined, "ses_a")
      const second = await run(args, undefined, "ses_b")

      expect(first.output.out).toBe(path.join(dir, "cat.png"))
      expect(second.output.out).toBe(path.join(other, "cat.png"))
      expect(calls.sessionGet).toEqual([{ sessionID: "ses_a" }, { sessionID: "ses_b" }])
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  test("resolves reference images against the session directory", async () => {
    const fetchMock = stubFetch()
    await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
    const { run } = await loadV2Tool({ directory: dir })

    await run({ ...args, images: ["ref.png"] })

    expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/images/edits")
  })
})

describe("OpenCode 2 credentials", () => {
  test.each(["chatgpt-browser", "chatgpt-headless"])(
    "accepts %s OAuth and maps metadata.accountID",
    async (methodID) => {
      const fetchMock = stubFetch()
      const credential = {
        ...CHATGPT_BROWSER_CREDENTIAL,
        methodID,
        access: "tok-v2",
        metadata: { accountID: "acct-2" },
      }
      const { run } = await loadV2Tool({ directory: dir, credential })

      await run(args)

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
      expect(headers.Authorization).toBe("Bearer tok-v2")
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-2")
    },
  )

  test.each([
    ["no metadata", undefined],
    ["a non-string accountID", { accountID: 42 }],
  ])("omits the account header with %s", async (_name, metadata) => {
    const fetchMock = stubFetch()
    const { run } = await loadV2Tool({ directory: dir, credential: { ...CHATGPT_BROWSER_CREDENTIAL, metadata } })

    await run(args)

    expect(fetchMock.mock.calls[0][1].headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
  })

  test("resolves the active connection again on every call", async () => {
    stubFetch()
    const { calls, run } = await loadV2Tool({ directory: dir })

    await run(args)
    await run(args)

    expect(calls.active).toEqual(["openai", "openai"])
    expect(calls.resolve).toHaveLength(2)
  })

  const rejected: Array<[string, Parameters<typeof loadV2Tool>[0], string]> = [
    ["no active connection", { connection: undefined }, "No OpenAI connection is active."],
    ["a connection without a credential", { credential: undefined }, "has no usable credential"],
    ["an API key", { credential: { type: "key", key: "sk-test" } }, "an API key is not sufficient"],
    [
      "an environment key",
      { connection: { type: "env", name: "OPENAI_API_KEY" }, credential: { type: "key", key: "sk" } },
      "an API key is not sufficient",
    ],
    [
      "an external credential",
      { credential: { type: "external", methodID: "chatgpt-browser" } },
      "not a ChatGPT sign-in",
    ],
    [
      "ChatGPT token-sharing sign-in",
      { credential: { ...CHATGPT_BROWSER_CREDENTIAL, methodID: "chatgpt-token-sharing" } },
      "token-sharing sign-in cannot call the Codex image backend",
    ],
    [
      "an unknown OAuth method",
      { credential: { ...CHATGPT_BROWSER_CREDENTIAL, methodID: "something-new" } },
      'Unsupported OpenAI sign-in method "something-new"',
    ],
  ]
  test.each(rejected)(
    "fails with a sign-in hint for %s and never falls back to OpenCode 1 credentials",
    async (_name, options, message) => {
      const fetchMock = stubFetch()
      const { run } = await loadV2Tool({ directory: dir, ...options })

      const error = await run(args).then(
        () => new Error("the call did not fail"),
        (caught: Error) => caught,
      )

      expect(error.message).toContain(message)
      expect(error.message).toContain("Codex browser or Codex device code")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    ["active", new Error("connection store unavailable")],
    ["resolve", new Error("token refresh failed")],
  ])("propagates a %s lookup failure unchanged", async (stage, failure) => {
    const fetchMock = stubFetch()
    const { run } = await loadV2Tool({
      directory: dir,
      ...(stage === "active" ? { activeError: failure } : { resolveError: failure }),
    })

    await expect(run(args)).rejects.toBe(failure)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("OpenCode 2 image API key", () => {
  function runApi(options: Parameters<typeof loadV2Tool>[0] = {}) {
    return loadV2Tool({ directory: dir, pluginOptions: API_OPTIONS, ...options })
  }

  test("resolves only the openai-images connection, on every call, and sends its key", async () => {
    const fetchMock = stubFetch()
    const { calls, run } = await runApi()

    await run(args)
    await run(args)

    expect(calls.active).toEqual(["openai-images", "openai-images"])
    expect(calls.resolve).toHaveLength(2)
    const headers = fetchMock.mock.calls.map(([, init]) => init.headers as Record<string, string>)
    expect(headers.map((header) => header.Authorization)).toEqual(["Bearer sk-images", "Bearer sk-images"])
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/generations")
  })

  test("never falls back to the OpenAI sign-in or to OpenCode 1 credentials", async () => {
    const fetchMock = stubFetch()
    const { calls, run } = await runApi({ integrations: { "openai-images": { connection: undefined } } })

    await expect(run(args)).rejects.toThrow(
      "No OpenAI Images API connection is active. Add an API key to the openai-images integration.",
    )

    expect(calls.active).toEqual(["openai-images"])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("leaves the OpenAI chat credentials unread and unchanged", async () => {
    stubFetch()
    const { calls, run } = await runApi()

    await run(args)

    expect(calls.active).not.toContain("openai")
    expect(calls.resolve).not.toContain(undefined)
  })

  test("the Codex backend reads only the OpenAI connection, never the image key", async () => {
    stubFetch()
    const { calls, run } = await loadV2Tool({ directory: dir })

    await run(args)

    expect(calls.active).toEqual(["openai"])
  })

  test.each([
    ["a connection without a credential", undefined, "has no usable credential. Add an API key"],
    [
      "an OAuth credential",
      CHATGPT_BROWSER_CREDENTIAL,
      "is not an API key. Add an API key to the openai-images integration.",
    ],
  ])("fails clearly for %s", async (_name, credential, message) => {
    const fetchMock = stubFetch()
    const connection = { type: "credential", id: "cred_2", method: "key" }
    const { run } = await runApi({ integrations: { "openai-images": { connection, credential } } })

    await expect(run(args)).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    ["active", new Error("connection store unavailable")],
    ["resolve", new Error("could not read the connection")],
  ])("propagates a %s lookup failure unchanged", async (stage, failure) => {
    const fetchMock = stubFetch()
    const { run } = await runApi(stage === "active" ? { activeError: failure } : { resolveError: failure })

    await expect(run(args)).rejects.toBe(failure)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
