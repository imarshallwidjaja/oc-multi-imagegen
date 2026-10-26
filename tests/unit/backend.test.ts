import { describe, expect, test } from "bun:test"
import { selectBackend } from "../../src/backend"
import plugin from "../../src/index"
import { isolateEnvironment } from "./fixtures"
import { loadV2Tool } from "./hosts"

isolateEnvironment()

describe("selectBackend", () => {
  test.each([undefined, null, {}])("selects Codex when the variable is unset and the options are %p", (options) => {
    expect(selectBackend(options).id).toBe("codex")
  })

  test("selects each backend by the id in OC_MULTI_IMAGEGEN_BACKEND", () => {
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "codex"
    expect(selectBackend(undefined).id).toBe("codex")
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "openai-api"
    expect(selectBackend(undefined).id).toBe("openai-api")
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "nano-gpt"
    expect(selectBackend(undefined).id).toBe("nano-gpt")
  })

  test("gives each backend its own credential, so a credential for one is never read for the other", () => {
    expect(selectBackend(undefined).credential).toMatchObject({ type: "oauth", provider: "openai" })
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "openai-api"
    expect(selectBackend(undefined).credential).toMatchObject({
      type: "key",
      provider: "openai-images",
      environmentVariable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
    })
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "nano-gpt"
    expect(selectBackend(undefined).credential).toMatchObject({
      type: "key",
      provider: "nano-gpt-images",
      environmentVariable: "OC_MULTI_IMAGEGEN_NANOGPT_API_KEY",
    })
  })

  test("registers the tools each backend declares, and only those", () => {
    const names = (backend: string) => {
      process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
      return selectBackend(undefined).tools.map((tool) => tool.name)
    }

    expect(names("codex")).toEqual(["imagegen"])
    expect(names("openai-api")).toEqual(["imagegen"])
    expect(names("nano-gpt")).toEqual(["imagegen", "imageedit", "imagegen_models"])
  })

  test.each([
    ["", "is empty"],
    ["dall-e", "is not a known backend"],
    ["OPENAI-API", "is not a known backend"],
    ["nano-gpt ", "is not a known backend"],
    [" openai-api", "is not a known backend"],
  ])("fails for the value %j instead of falling back to Codex, and does not repeat it", (value, reason) => {
    process.env.OC_MULTI_IMAGEGEN_BACKEND = value

    const error = (() => {
      try {
        return selectBackend(undefined)
      } catch (caught) {
        return caught as Error
      }
    })()

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`OC_MULTI_IMAGEGEN_BACKEND ${reason}. Use codex, openai-api or nano-gpt`)
    if (value === "dall-e") expect((error as Error).message).not.toContain(value)
  })

  test.each([[{ backend: "openai-api" }], [{ backend: "codex" }], [{ backend: "dall-e", other: 1 }]])(
    "fails for the earlier backend option %p with the variable to use instead",
    (options) => {
      expect(() => selectBackend(options)).toThrow(
        'The oc-multi-imagegen "backend" plugin option is no longer supported.',
      )
      expect(() => selectBackend(options)).toThrow("OC_MULTI_IMAGEGEN_BACKEND=codex|openai-api|nano-gpt")
    },
  )

  test.each([[{ model: "x" }], [{ a: 1, b: 2 }], ["openai-api"], [["openai-api"]]])(
    "fails for the options %p, which the plugin does not take",
    (options) => {
      expect(() => selectBackend(options)).toThrow("takes no plugin options")
    },
  )
})

// Both hosts pass the options they were configured with and read the variable once, when the plugin loads.
const hosts: Array<[string, (options?: Record<string, unknown>) => Promise<{ description: string }>]> = [
  [
    "OpenCode 1",
    async (options) => {
      const hooks = await plugin.server({} as never, options)
      return { description: hooks.tool?.imagegen.description ?? "" }
    },
  ],
  ["OpenCode 2", async (options) => ({ description: (await loadV2Tool({ pluginOptions: options })).tool.description })],
]
const codexDescription = () => selectBackend(undefined).tools[0].description

describe.each(hosts)("%s backend selection", (_host, load) => {
  test("loads Codex without a variable, whether or not the host passes empty options", async () => {
    expect((await load()).description).toBe(codexDescription())
    expect((await load({})).description).toBe(codexDescription())
  })

  test("loads the backend the variable selects", async () => {
    process.env.OC_MULTI_IMAGEGEN_BACKEND = "openai-api"

    expect((await load()).description).toContain("OpenAI Images API")
  })

  test.each([
    [
      "an unknown backend variable",
      () => (process.env.OC_MULTI_IMAGEGEN_BACKEND = "dall-e"),
      undefined,
      "OC_MULTI_IMAGEGEN_BACKEND",
    ],
    ["an empty backend variable", () => (process.env.OC_MULTI_IMAGEGEN_BACKEND = ""), undefined, "is empty"],
    ["the earlier backend option", () => {}, { backend: "openai-api" }, "no longer supported"],
  ])("fails the load for %s, and the tool is not registered", async (_name, arrange, options, message) => {
    arrange()

    await expect(load(options)).rejects.toThrow(message)
  })
})
