import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { selectBackend } from "../../src/backend"
import plugin from "../../src/index"
import { SKILL_NAME } from "../../src/skill"
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

  // The host tests check that each host registers exactly these tools by name.
  test("declares the tools of each backend", () => {
    const names = (backend: string) => {
      process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
      return selectBackend(undefined).tools.map((tool) => tool.name)
    }

    expect(names("codex")).toEqual(["imagegen", "imageedit"])
    expect(names("openai-api")).toEqual(["imagegen", "imageedit", "imagegen_models"])
    expect(names("nano-gpt")).toEqual(["imagegen", "imageedit", "imagegen_models"])
  })

  // The out argument names the formats each tool saves; imagegen.test.ts checks through both hosts that saving accepts
  // and refuses the same ones.
  test.each([
    ["codex", { imagegen: "PNG, JPEG or WebP", imageedit: "PNG, JPEG or WebP" }],
    ["openai-api", { imagegen: "PNG, JPEG, WebP, GIF or SVG", imageedit: "PNG, JPEG or WebP" }],
    ["nano-gpt", { imagegen: "PNG, JPEG or WebP", imageedit: "PNG, JPEG or WebP" }],
  ])("each %s image tool's out argument names the formats it saves", (backend, expected) => {
    process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
    const images = selectBackend(undefined).tools.filter((tool) => tool.kind === "image")

    const described = Object.fromEntries(
      images.map((tool) => {
        const schema = z.toJSONSchema(tool.schema, { io: "input" }) as unknown as {
          properties: { out: { description: string } }
        }
        return [tool.name, /Saves native (.+?) bytes/.exec(schema.properties.out.description)?.[1]]
      }),
    )
    expect(described).toEqual(expected)
  })

  // OpenCode 2.3.2's Code Mode catalog shows only the first line of a description and cuts a line longer than 500
  // characters to its first 497 (DESCRIPTION_LIMIT - 3) plus "...". Each description is therefore one line whose first
  // 497 characters carry the routing, skill, discovery, credential and critical rules of the tool.
  const CODE_MODE_PREVIEW = 497
  const credentialCue = { codex: "ChatGPT OAuth", "openai-api": "OpenAI Images API key", "nano-gpt": "NanoGPT API key" }
  const codexUnverified =
    "Model and quality are sent unchanged but unverified; the result separates requested from verified settings."
  const openaiNoRepeat = "Do not repeat a rejected call unchanged."
  const nanoNoRetry = "Never switch a requested model silently or repeat an unchanged call."
  const criticalCue: Record<string, Record<string, string[]>> = {
    codex: { imagegen: [codexUnverified], imageedit: [codexUnverified] },
    "openai-api": {
      imagegen: [openaiNoRepeat],
      imageedit: ["GIF and SVG come only from imagegen.", openaiNoRepeat],
      imagegen_models: [
        "GET /v1/models",
        "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
        "openai-images",
        "permission",
        "not cached or retried.",
      ],
    },
    "nano-gpt": { imagegen: [nanoNoRetry], imageedit: [nanoNoRetry] },
  }
  test.each(["codex", "openai-api", "nano-gpt"] as const)(
    "each %s tool description is one line that leads with its critical rules",
    (backend) => {
      process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
      for (const tool of selectBackend(undefined).tools) {
        expect(tool.description).not.toContain("\n")
        const preview = tool.description.slice(0, CODE_MODE_PREVIEW)
        const expected =
          tool.kind === "image"
            ? [
                tool.name === "imagegen" ? "use imageedit" : "use imagegen",
                SKILL_NAME,
                credentialCue[backend],
                "sent to",
                ...(backend === "codex" ? [] : ["Call imagegen_models first"]),
                ...(tool.name === "imageedit" ? ["pixel-exact edits need an image editor"] : []),
                ...criticalCue[backend][tool.name],
                "Use the returned out path for reads or edits.",
              ]
            : ["before choosing a model for imagegen or imageedit", ...(criticalCue[backend][tool.name] ?? [])]
        for (const cue of expected)
          expect({ tool: tool.name, preview }).toEqual({ tool: tool.name, preview: expect.stringContaining(cue) })
      }
    },
  )

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
const codexDescription = () =>
  selectBackend(undefined).tools.find((tool) => tool.name === "imagegen")?.description ?? ""

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
