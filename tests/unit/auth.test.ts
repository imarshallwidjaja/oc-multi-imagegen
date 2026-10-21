import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isolateEnvironment } from "./fixtures"

const XDG = mkdtempSync(path.join(os.tmpdir(), "auth-xdg-"))
const AUTH_FILE = path.join(XDG, "opencode", "auth.json")
mkdirSync(path.dirname(AUTH_FILE), { recursive: true })

isolateEnvironment()
let loadStoredCredential: typeof import("../../src/auth").loadStoredCredential
let loadCredential: typeof import("../../src/auth").loadCredential

beforeAll(async () => {
  // xdg-basedir reads XDG_DATA_HOME only once, when it is first imported, and another test file
  // may import it before this one. mock.module also replaces the module for files that already
  // imported it, so auth.json is read from the temp dir regardless of the test file order.
  mock.module("xdg-basedir", () => ({ xdgData: XDG }))
  const auth = await import("../../src/auth")
  loadStoredCredential = auth.loadStoredCredential
  loadCredential = auth.loadCredential
})

afterAll(() => {
  rmSync(XDG, { recursive: true, force: true })
})

function writeAuthFile(content: string): void {
  writeFileSync(AUTH_FILE, content)
}

beforeEach(() => {
  // Start each test from a no-credentials baseline; tests opt in to a file.
  writeAuthFile("{}")
})

const OAUTH = { type: "oauth", provider: "openai", label: "OpenAI ChatGPT OAuth" } as const
const KEY = {
  type: "key",
  provider: "openai-images",
  label: "OpenAI Images API",
  environmentVariable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
} as const

describe("loadStoredCredential", () => {
  test("reads a valid oauth entry from OPENCODE_AUTH_CONTENT", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok-env", refresh: "r", expires: 1, accountId: "acct-1" },
    })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok-env", accountId: "acct-1" })
  })

  test("reads a key saved as an api entry and ignores its metadata", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "openai-images": { type: "api", key: "sk-images", metadata: { note: "x" } },
    })
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-images" })
  })

  test("prefers OPENCODE_AUTH_CONTENT over the auth.json file", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok-env" } })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok-env" })
  })

  test("falls back to the auth.json file when the env var is unset", async () => {
    writeAuthFile(JSON.stringify({ "openai-images": { type: "api", key: "sk-file" } }))
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-file" })
  })

  test("falls back to the auth.json file when OPENCODE_AUTH_CONTENT does not parse, as OpenCode does", async () => {
    writeAuthFile(JSON.stringify({ "openai-images": { type: "api", key: "sk-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = "{not json sk-secret-in-the-text"
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-file" })
  })

  test("reads only the entry the backend names", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok" },
      "openai-images": { type: "api", key: "sk-images" },
    })
    expect(await loadStoredCredential(OAUTH)).toEqual({ type: "oauth", access: "tok" })
    expect(await loadStoredCredential(KEY)).toEqual({ type: "key", key: "sk-images" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    expect(await loadStoredCredential(KEY)).toBeUndefined()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "sk-chat" } })
    expect(await loadStoredCredential(KEY)).toBeUndefined()
  })

  test.each([
    ["an api entry where oauth is needed", OAUTH, { openai: { type: "api", key: "sk" } }],
    ["an oauth entry where a key is needed", KEY, { "openai-images": { type: "oauth", access: "tok" } }],
    ["an oauth entry whose access is not a string", OAUTH, { openai: { type: "oauth", access: 123 } }],
    ["a key that is empty", KEY, { "openai-images": { type: "api", key: "" } }],
    ["a key that is not a string", KEY, { "openai-images": { type: "api", key: 7 } }],
    ["an entry that is not an object", KEY, { "openai-images": "sk-images" }],
    ["no entry for the provider", OAUTH, { anthropic: { type: "oauth", access: "tok" } }],
    ["content that is not an object", OAUTH, ["openai"]],
  ])("returns undefined for %s", async (_name, spec, content) => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(content)
    expect(await loadStoredCredential(spec)).toBeUndefined()
  })

  test("returns undefined, without an error, when neither source holds usable JSON", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    writeAuthFile("{also not json")
    expect(await loadStoredCredential(KEY)).toBeUndefined()
  })

  test("returns undefined when the auth.json file is missing", async () => {
    rmSync(AUTH_FILE, { force: true })
    expect(await loadStoredCredential(OAUTH)).toBeUndefined()
  })
})

describe("loadCredential", () => {
  const SAVED = { "openai-images": { type: "api", key: "sk-saved" } }

  test("uses the variable a key credential names ahead of the saved entry, read on every call", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(SAVED)

    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = "sk-env-1"
    expect(await loadCredential(KEY)).toEqual({ type: "key", key: "sk-env-1" })
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = "sk-env-2"
    expect(await loadCredential(KEY)).toEqual({ type: "key", key: "sk-env-2" })
  })

  test("uses the saved entry when the variable is absent", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(SAVED)

    expect(await loadCredential(KEY)).toEqual({ type: "key", key: "sk-saved" })
  })

  test("fails for a variable that is set but empty, without falling back to the saved entry", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(SAVED)
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ""

    await expect(loadCredential(KEY)).rejects.toThrow("OC_MULTI_IMAGEGEN_OPENAI_API_KEY is set but empty.")
  })

  test("never applies the image key variable to an oauth credential", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = "sk-env"

    expect(await loadCredential(OAUTH)).toEqual({ type: "oauth", access: "tok" })
  })
})
