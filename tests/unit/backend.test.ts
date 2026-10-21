import { describe, expect, test } from "bun:test"
import { selectBackend } from "../../src/backend"

describe("selectBackend", () => {
  test.each([undefined, null, {}])("selects Codex when the options are %p", (options) => {
    expect(selectBackend(options).id).toBe("codex")
  })

  test("selects each backend by id", () => {
    expect(selectBackend({ backend: "codex" }).id).toBe("codex")
    expect(selectBackend({ backend: "openai-api" }).id).toBe("openai-api")
  })

  test("gives each backend its own credential, so a credential for one is never read for the other", () => {
    expect(selectBackend({ backend: "codex" }).credential).toMatchObject({ type: "oauth", provider: "openai" })
    expect(selectBackend({ backend: "openai-api" }).credential).toMatchObject({
      type: "key",
      provider: "openai-images",
    })
  })

  test.each([
    [{ backend: "dall-e" }, "backend"],
    [{ backend: "OPENAI-API" }, "backend"],
    [{ backend: 1 }, "backend"],
    [{ backned: "openai-api" }, "Unrecognized key"],
    ["openai-api", "expected object"],
  ])("fails the load for the options %p instead of falling back to Codex", (options, message) => {
    expect(() => selectBackend(options)).toThrow(message)
    expect(() => selectBackend(options)).toThrow("Invalid oc-multi-imagegen options.")
  })
})
