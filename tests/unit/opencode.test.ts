import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HostGenerateImageResult, HostImageModel } from "../../src/credential"
import { isolateEnvironment, PNG_BASE64, PNG_BUFFER } from "./fixtures"
import { loadV2Tool, type V2Options } from "./hosts"

isolateEnvironment()
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "opencode-"))
  // The backend generates through the host, never through the plugin's own network access.
  globalThis.fetch = mock(async () => {
    throw new Error("the opencode backend must not fetch")
  }) as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

const image = (input: string[], output: string[], extra: Partial<HostImageModel> = {}): HostImageModel => ({
  providerID: "openai",
  id: "gpt-image-2",
  modelID: "gpt-image-2",
  name: "GPT Image 2",
  enabled: true,
  status: "active",
  variants: [],
  capabilities: { tools: false, input, output },
  time: { released: 0 },
  cost: [],
  limit: { context: 0, output: 0 },
  ...extra,
})

// An image model with a multi-slash ID and a variant that accepts input images; one that only generates and is
// recognized by its output capability alone; and models the catalog must hide: a disabled image model and a chat model.
const FLUX = image(["text", "image"], ["image"], {
  providerID: "openrouter",
  id: "black-forest-labs/flux-2-pro",
  name: "FLUX.2 Pro",
  type: "image",
  variants: [{ id: "hd" }, { id: "fast" }],
})
const GPT_IMAGE = image(["text"], ["image/png"])
const DISABLED = image(["text", "image"], ["image"], {
  id: "gpt-image-old",
  name: "Old",
  enabled: false,
  type: "image",
})
const CHAT = image(["text", "image"], ["text"], { providerID: "anthropic", id: "claude", name: "Claude", type: "chat" })
const CATALOG = [FLUX, GPT_IMAGE, DISABLED, CHAT]

const FLUX_REF = "openrouter/black-forest-labs/flux-2-pro"
const generateArgs = { prompt: "a cat", out: "cat.png", model: FLUX_REF }
const editArgs = { prompt: "make the cat orange", out: "cat.png", model: FLUX_REF, images: ["ref.png"] }

function load(options: V2Options = {}) {
  return loadV2Tool({ directory: dir, backend: "opencode", imageModels: CATALOG, ...options })
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => new Error("the call did not fail"),
    (caught: Error) => caught,
  )
}

// Each request the call made to the method received the call's own signal.
function expectSignal(requests: Array<{ signal?: AbortSignal } | undefined>, signal: AbortSignal) {
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) expect(request?.signal).toBe(signal)
}

describe("opencode imagegen", () => {
  test("generates through the host with the parsed model, variant, aspect and resolution, and saves the image", async () => {
    const { calls, run } = await load({ sessionDirectories: { ses_test: dir } })
    const { signal } = new AbortController()

    const result = await run({ ...generateArgs, model: `${FLUX_REF}#hd`, aspect: "16:9", resolution: "2K" }, signal)

    expect(calls.generateImage).toEqual([
      {
        model: { providerID: "openrouter", id: "black-forest-labs/flux-2-pro", variant: "hd" },
        prompt: "a cat",
        n: 1,
        aspect: "16:9",
        resolution: "2K",
      },
    ])
    expect(calls.modelList).toEqual([{ types: ["image"] }])
    expectSignal(calls.requestOptions.modelList, signal)
    expectSignal(calls.requestOptions.generateImage, signal)
    expectSignal(calls.requestOptions.sessionGet, signal)
    expect(calls.assert.map((request) => [request.action, request.resources])).toEqual([["imagegen", ["opencode"]]])
    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    expect(result.output.message).toContain(
      "Requested aspect 16:9 and resolution 2K; OpenCode does not report what the provider applied",
    )
  })

  test("sends no aspect, resolution, variant or images when they are omitted or null, and adds no note", async () => {
    const { calls, run } = await load()

    const result = await run({ ...generateArgs, model: "openai/gpt-image-2", aspect: null, resolution: null })

    expect(calls.generateImage).toEqual([{ model: { providerID: "openai", id: "gpt-image-2" }, prompt: "a cat", n: 1 }])
    expect(result.output.message).not.toContain("Requested")
  })

  test.each([
    [
      "size",
      { ...generateArgs, size: "1024x1024" },
      "Unsupported argument: size. This backend takes no size: use aspect",
    ],
    ["reference images", { ...generateArgs, images: ["ref.png"] }, "use imageedit"],
    ["a model without a provider", { ...generateArgs, model: "flux-2-pro" }, "has no provider"],
    ["an empty provider ID", { ...generateArgs, model: "/gpt-image-2" }, "empty provider ID"],
    ["an empty model ID", { ...generateArgs, model: "openai/" }, "empty model ID"],
    ["a variant without a model ID", { ...generateArgs, model: "openai/#hd" }, "empty model ID"],
    ["an empty variant", { ...generateArgs, model: `${FLUX_REF}#` }, "empty variant"],
    ['"#" in the provider ID', { ...generateArgs, model: "open#ai/gpt-image-2" }, '"#" in its provider ID'],
    ['a second "#" in the variant', { ...generateArgs, model: "openai/gpt-image-2#low#high" }, 'more than one "#"'],
    ["a malformed aspect", { ...generateArgs, aspect: "wide" }, "WIDTH:HEIGHT"],
    ["a zero aspect", { ...generateArgs, aspect: "0:0" }, "WIDTH:HEIGHT of positive numbers"],
    ["a zero aspect width", { ...generateArgs, aspect: "0:1" }, "WIDTH:HEIGHT of positive numbers"],
    ["a zero aspect height", { ...generateArgs, aspect: "16:0" }, "WIDTH:HEIGHT of positive numbers"],
    ["a decimal zero aspect width", { ...generateArgs, aspect: "0.0:1" }, "WIDTH:HEIGHT of positive numbers"],
    ["an empty resolution", { ...generateArgs, resolution: "" }, "at resolution"],
    ["a missing model", { prompt: "a cat", out: "cat.png" }, "at model"],
  ])("the host-validated input refuses %s before any permission", async (_name, args, message) => {
    const { calls, run, tool } = await load()

    const validated = (await tool.input["~standard"].validate(args)) as {
      issues?: Array<{ message: string; path?: PropertyKey[] }>
    }
    const issues = validated.issues?.map((issue) => `${issue.message} at ${issue.path?.join(".")}`)
    expect(issues?.join(" ")).toContain(message)
    expect((await failure(run(args))).message).toContain(message)
    expect(calls.assert).toEqual([])
    expect(calls.generateImage).toEqual([])
  })

  test("accepts positive aspect ratios, including decimals", async () => {
    const { tool } = await load()

    for (const aspect of ["16:9", "1:1", "0.5:1", "1.91:1"]) {
      expect(await tool.input["~standard"].validate({ ...generateArgs, aspect })).not.toHaveProperty("issues")
    }
  })

  test.each([
    [
      "an unknown model",
      "openai/dall-e-3",
      "openai/dall-e-3 is not an enabled image model in OpenCode. Call imagegen_models",
    ],
    ["a disabled model", "openai/gpt-image-old", "is not an enabled image model"],
    ["a model that does not make images", "anthropic/claude", "is not an enabled image model"],
    ["an unknown variant", `${FLUX_REF}#ultra`, `${FLUX_REF} has no variant "ultra". Its variants are: hd, fast.`],
    [
      "a variant of a model without variants",
      "openai/gpt-image-2#hd",
      'openai/gpt-image-2 has no variants; omit "#hd".',
    ],
  ])("refuses %s against the session's catalog without generating", async (_name, model, message) => {
    const { calls, run } = await load()

    expect((await failure(run({ ...generateArgs, model }))).message).toContain(message)
    expect(calls.generateImage).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each([
    ["no images", { images: [] }],
    ["an empty image", { images: [{ type: "image", data: "", mime: "image/png" }] }],
    ["no image list", {}],
  ])("fails and saves nothing when the host returns %s", async (_name, response) => {
    const { run } = await load({ generateImage: async () => response as HostGenerateImageResult })

    expect((await failure(run(generateArgs))).message).toBe(`OpenCode returned no image for ${FLUX_REF}.`)
    expect(await readdir(dir)).toEqual([])
  })

  test("propagates a host generation failure unchanged and saves nothing", async () => {
    const rejection = new Error("provider rejected the prompt")
    const { run } = await load({ generateImage: async () => Promise.reject(rejection) })

    expect(await failure(run(generateArgs))).toBe(rejection)
    expect(await readdir(dir)).toEqual([])
  })

  test("a cancellation during generation rejects with the signal's reason at once and saves nothing", async () => {
    const controller = new AbortController()
    let started!: () => void
    const generating = new Promise<void>((resolve) => {
      started = resolve
    })
    // The host never answers, so only the cancellation can settle the call.
    const { run } = await load({
      generateImage: () => {
        started()
        return new Promise(() => {})
      },
    })

    const call = run(generateArgs, controller.signal)
    await generating
    const reason = new Error("stopped by the user")
    controller.abort(reason)

    expect(await failure(call)).toBe(reason)
    expect(await readdir(dir)).toEqual([])
  })

  test("a cancellation while a host that ignores the signal lists models rejects with its reason and generates nothing", async () => {
    const controller = new AbortController()
    const reason = new Error("stopped by the user")
    // The catalog answers only after the call is cancelled, as on OpenCode 2.3.2.
    const { calls, run } = await load({
      modelListIgnoresSignal: true,
      imageModels: async () => {
        controller.abort(reason)
        return CATALOG
      },
    })

    expect(await failure(run(generateArgs, controller.signal))).toBe(reason)
    expect(calls.modelList).toHaveLength(1)
    expect(calls.generateImage).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each([
    ["imagegen", generateArgs],
    ["imagegen_models", {}],
  ])(
    "%s: a cancellation while the host lists models rejects with the signal's reason and generates nothing",
    async (name, args) => {
      const controller = new AbortController()
      let started!: () => void
      const listing = new Promise<void>((resolve) => {
        started = resolve
      })
      // The catalog never answers, so only the cancellation can settle the call.
      const { calls, run } = await load({
        imageModels: () => {
          started()
          return new Promise(() => {})
        },
      })

      const call = run(args, controller.signal, undefined, name)
      await listing
      const reason = new Error("stopped by the user")
      controller.abort(reason)

      expect(await failure(call)).toBe(reason)
      expect(calls.generateImage).toEqual([])
      expect(await readdir(dir)).toEqual([])
    },
  )
})

describe("opencode imageedit", () => {
  test("sends each reference image as base64 data with its MIME type", async () => {
    await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
    const { calls, run } = await load()
    const { signal } = new AbortController()

    await run(editArgs, signal, undefined, "imageedit")

    expect(calls.generateImage).toEqual([
      {
        model: { providerID: "openrouter", id: "black-forest-labs/flux-2-pro" },
        prompt: "make the cat orange",
        n: 1,
        images: [{ data: PNG_BASE64, mime: "image/png" }],
      },
    ])
    expectSignal(calls.requestOptions.modelList, signal)
    expectSignal(calls.requestOptions.generateImage, signal)
  })

  test("refuses a model that does not accept input images and names ones that do", async () => {
    await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
    const { calls, run } = await load()

    const error = await failure(run({ ...editArgs, model: "openai/gpt-image-2" }, undefined, undefined, "imageedit"))

    expect(error.message).toBe(
      `openai/gpt-image-2 does not accept input images, so it cannot edit. Models that can include: ${FLUX_REF}.`,
    )
    expect(calls.generateImage).toEqual([])
  })

  test("says so when no enabled image model accepts input images", async () => {
    await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
    const { run } = await load({ imageModels: [GPT_IMAGE, DISABLED] })

    const error = await failure(run({ ...editArgs, model: "openai/gpt-image-2" }, undefined, undefined, "imageedit"))

    expect(error.message).toContain("and no enabled image model in OpenCode does.")
  })

  test.each([
    ["size", { ...editArgs, size: "1024x1024" }, "use aspect"],
    ["no reference image", { ...editArgs, images: [] }, "needs at least one reference image"],
    ["nine reference images", { ...editArgs, images: Array(9).fill("ref.png") }, "takes at most 8 reference images"],
  ])("refuses %s before any permission", async (_name, args, message) => {
    const { calls, run } = await load()

    expect((await failure(run(args, undefined, undefined, "imageedit"))).message).toContain(message)
    expect(calls.assert).toEqual([])
  })
})

describe("opencode imagegen_models", () => {
  const lookup = async (args: Record<string, unknown>, options: V2Options = {}, signal?: AbortSignal) => {
    const loaded = await load(options)
    const result = (await loaded.run(args, signal, undefined, "imagegen_models")) as unknown as { content: string }
    return { ...loaded, text: result.content }
  }

  test("lists the enabled image models with their variants and edit capability, after asking for permission", async () => {
    const { signal } = new AbortController()
    const { calls, text } = await lookup({}, {}, signal)

    expect(text.split("\n")).toEqual([
      "Enabled OpenCode image models (2 of 2). Pass providerID/modelID, or providerID/modelID#variant, as model:",
      `- ${FLUX_REF} (FLUX.2 Pro); edit: yes; variants: hd, fast`,
      "- openai/gpt-image-2 (GPT Image 2); edit: no",
    ])
    expect(calls.assert.map((request) => [request.action, request.resources])).toEqual([
      ["imagegen_models", ["opencode"]],
    ])
    expect(calls.modelList).toEqual([{ types: ["image"] }])
    expectSignal(calls.requestOptions.modelList, signal)
    // A lookup resolves no session directory.
    expect(calls.sessionGet).toEqual([])
    expect(calls.generateImage).toEqual([])
  })

  test("filters by query words that must all match the reference or the name, ignoring case", async () => {
    expect((await lookup({ query: "FLUX openrouter" })).text).toContain(`(1 of 2)`)
    expect((await lookup({ query: "flux openai" })).text).toContain('No enabled image model matching "flux openai"')
  })

  test("checks one exact model reference", async () => {
    expect((await lookup({ model: "openai/gpt-image-2" })).text).toBe("- openai/gpt-image-2 (GPT Image 2); edit: no")
    expect((await lookup({ model: "openai/gpt-image-old" })).text).toContain(
      "openai/gpt-image-old is not an enabled image model in OpenCode.",
    )
  })

  test("says when no image model is connected", async () => {
    expect((await lookup({}, { imageModels: [CHAT] })).text).toContain(
      "No enabled image model is connected in OpenCode.",
    )
  })

  test("refuses a model combined with a query before any permission", async () => {
    const loaded = await load()

    const error = await failure(loaded.run({ model: "a/b", query: "flux" }, undefined, undefined, "imagegen_models"))

    expect(error.message).toContain("model cannot be combined with query.")
    expect(loaded.calls.assert).toEqual([])
  })
})

describe("opencode backend load", () => {
  test("fails the load on a host without image generation and a model catalog, without registering a tool", async () => {
    const error = await failure(load({ hostImageApi: false }))

    expect(error.message).toBe(
      'The "opencode" backend requires an OpenCode 2 host with ctx.experimental.generate.image and ctx.model.list.',
    )
  })

  test("other backends still load on such a host", async () => {
    const { registered } = await loadV2Tool({ directory: dir, hostImageApi: false })

    expect(registered.map((tool) => tool.name)).toEqual(["imagegen", "imageedit"])
  })
})
