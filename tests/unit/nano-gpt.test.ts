import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ImageCredential } from "../../src/credential"
import plugin from "../../src/index"
import { nanoGptBackend } from "../../src/nano-gpt"
import {
  CONTROL_NAMES,
  controlsOf,
  editSchema,
  findModel,
  generateSchema,
  MODELS,
  type NanoModel,
} from "../../src/nano-gpt-models"
import type { ImageTool, ImageToolHost } from "../../src/types"
import { isolateEnvironment, JPEG_BUFFER, PNG_BASE64, PNG_BUFFER, WEBP_BUFFER } from "./fixtures"
import { loadV2Tool, STORED_CREDENTIALS, selectBackendVariable, v1ToolContext } from "./hosts"

// NanoGPT-specific behavior: the model registry and the schemas derived from it, the request each tool sends, how the
// response is read, and the local information tool. Behavior shared with the other backends (permission order,
// cancellation, versioning, credentials per host) is covered once in imagegen.test.ts, v1.test.ts and v2.test.ts.
// Every request here goes to a mocked fetch: nothing in this file shows that NanoGPT accepts these requests.
isolateEnvironment()
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(STORED_CREDENTIALS)
  dir = await mkdtemp(path.join(os.tmpdir(), "nano-"))
  await writeFile(path.join(dir, "ref.png"), PNG_BUFFER)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

const key: ImageCredential = { type: "key", key: "sk-nano" }
const ENDPOINT = "https://api.nano-gpt.com/api/v1/images"

function inlineResponse(b64 = PNG_BASE64): Response {
  return new Response(JSON.stringify({ created: 0, data: [{ b64_json: b64 }] }))
}

function stubFetch(
  respond: (url: string | URL, init: RequestInit) => Response | Promise<Response> = () => inlineResponse(),
) {
  const fetchMock = mock(async (url: string | URL, init: RequestInit) => respond(url, init))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const bodyOf = (fetchMock: ReturnType<typeof stubFetch>, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<string, unknown>

function tool(name: string): ImageTool {
  const found = nanoGptBackend.tools.find((candidate) => candidate.name === name)
  if (found?.kind !== "image") throw new Error(`${name} is not an image tool`)
  return found
}

// Runs a tool through the shared flow with a host that allows everything and returns the given credential.
function run(name: string, args: unknown, credential: ImageCredential = key, signal = new AbortController().signal) {
  const host: ImageToolHost = {
    signal,
    authorize: async () => {},
    resolveDirectory: async () => dir,
    resolveCredential: async () => credential,
  }
  return tool(name).run(args, host)
}

const generate = (extra: Record<string, unknown> = {}, model = "nano-banana-pro") =>
  run("imagegen", { model, prompt: "a cat", out: "cat.png", ...extra })
const edit = (extra: Record<string, unknown> = {}, model = "nano-banana-pro-edit") =>
  run("imageedit", { model, prompt: "make it orange", out: "cat.png", images: ["ref.png"], ...extra })

const EXPECTED_IDS = [
  ["openai/gpt-image-2.5/flare/text-to-image", "openai/gpt-image-2.5/flare/edit"],
  ["nano-banana-pro", "nano-banana-pro-edit"],
  ["black-forest-labs/flux-3/text-to-image", "black-forest-labs/flux-3/edit"],
  ["bytedance/seedream-v5.0-pro", "bytedance/seedream-v5.0-pro/edit"],
  ["qwen-image-2.1/text-to-image", "qwen-image-2.1/edit"],
]

const DUAL_IDS = [
  "qwen-image-3-pro",
  "bytedance/seedream-v5.0-pro",
  "wan2.7-image-pro",
  "meta/muse-image/text-to-image",
]

describe("NanoGPT model registry", () => {
  test("lists exactly the curated generation and edit pairs", () => {
    expect(MODELS.filter((model) => model.operation === "generate").map((model) => model.id)).toEqual([
      ...EXPECTED_IDS.map(([generateId]) => generateId),
      DUAL_IDS[0],
      DUAL_IDS[2],
      DUAL_IDS[3],
    ])
    expect(MODELS.filter((model) => model.operation === "edit").map((model) => model.id)).toEqual([
      EXPECTED_IDS[0][1],
      EXPECTED_IDS[1][1],
      EXPECTED_IDS[2][1],
      DUAL_IDS[1],
      EXPECTED_IDS[3][1],
      EXPECTED_IDS[4][1],
      DUAL_IDS[0],
      DUAL_IDS[2],
      DUAL_IDS[3],
    ])
    expect(new Set(MODELS.map((model) => `${model.operation}:${model.id}`)).size).toBe(MODELS.length)
    expect(new Set(MODELS.map((model) => model.id)).size).toBe(13)
  })

  // The schema and the registry are one source: each model accepts every value it lists and refuses the rest.
  describe.each(MODELS.map((model) => [model.id, model] as const))("%s", (_id, model: NanoModel) => {
    const schema = model.operation === "generate" ? generateSchema : editSchema
    const base = {
      model: model.id,
      prompt: "p",
      out: "o.png",
      ...(model.operation === "edit" ? { images: ["a.png"] } : {}),
    }

    test.each(
      controlsOf(model).flatMap((control) => (control.values ?? []).map((value) => [control.name, value] as const)),
    )("accepts %s %s", (name, value) => {
      expect(schema.safeParse({ ...base, [name]: value }).success).toBe(true)
    })

    test.each(
      controlsOf(model)
        .filter((control) => control.values)
        .map((control) => control.name),
    )("rejects a %s value it does not list, naming the allowed values", (name) => {
      const result = schema.safeParse({ ...base, [name]: "bogus" })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toContain(`Unsupported ${name} "bogus" for ${model.id}. Use one of:`)
    })

    test.each(CONTROL_NAMES.filter((name) => !controlsOf(model).some((control) => control.name === name)))(
      "rejects the %s control it does not take instead of dropping it",
      (name) => {
        const result = schema.safeParse({ ...base, [name]: name === "seed" ? 1 : "1k" })
        expect(result.error?.issues[0].message).toContain(`${name} is not supported by ${model.id}`)
      },
    )
  })

  test("differs per operation only where the provider lists different values", () => {
    const aspect = (operation: "generate" | "edit") =>
      findModel(operation, operation === "edit" ? "qwen-image-2.1/edit" : "qwen-image-2.1/text-to-image")?.aspectRatios
    expect(aspect("edit")).toContain("auto")
    expect(aspect("generate")).not.toContain("auto")
  })
})

describe("NanoGPT argument validation", () => {
  const messages = (schema: typeof generateSchema | typeof editSchema, value: unknown) =>
    schema.safeParse(value).error?.issues.map((issue) => issue.message) ?? []

  test("keeps meaningful unsupported controls visible instead of stripping them", () => {
    expect(
      messages(generateSchema, { model: "nano-banana-pro", prompt: "p", out: "o", quality: "high", seed: 3 }),
    ).toEqual([
      expect.stringContaining("quality is not supported by nano-banana-pro"),
      expect.stringContaining("seed is not supported by nano-banana-pro"),
    ])
  })

  test("sends an operation mismatch to the other tool", () => {
    expect(messages(generateSchema, { model: "qwen-image-2.1/edit", prompt: "p", out: "o" })[0]).toContain(
      "qwen-image-2.1/edit is for imageedit, not imagegen. Use imageedit with it, or imagegen with qwen-image-2.1/text-to-image.",
    )
    expect(
      messages(editSchema, { model: "qwen-image-2.1/text-to-image", prompt: "p", out: "o", images: ["a.png"] })[0],
    ).toContain("is for imagegen, not imageedit")
  })

  test("does not turn a near-miss model ID into a supported one", () => {
    for (const model of [
      "nano-banana-pro/edit",
      "NANO-BANANA-PRO",
      " nano-banana-pro",
      "nano-banana-pro\n",
      "bytedance/seedream-v5.0-pro/text-to-image",
    ]) {
      expect(messages(generateSchema, { model, prompt: "p", out: "o" })[0]).toContain("Unsupported generate model")
    }
  })

  test("limits the prompt by Unicode code points after trimming, only where the provider documents a limit", () => {
    const flare = "openai/gpt-image-2.5/flare/text-to-image"
    const atLimit = "𝔸".repeat(32000)
    expect(generateSchema.safeParse({ model: flare, prompt: atLimit, out: "o" }).success).toBe(true)
    expect(generateSchema.safeParse({ model: flare, prompt: ` ${atLimit} `, out: "o" }).success).toBe(true)
    expect(messages(generateSchema, { model: flare, prompt: `${atLimit}x`, out: "o" })[0]).toContain("at most 32000")
    expect(generateSchema.safeParse({ model: "nano-banana-pro", prompt: "x".repeat(100000), out: "o" }).success).toBe(
      true,
    )
  })

  // Attempts to widen a request past the curated contract: provider routing, streaming, output counts, legacy aliases.
  test.each([
    ["provider routing", { provider: { only: ["openai"] } }],
    ["streaming", { stream: true }],
    ["more outputs", { n: 4 }],
    ["a legacy alias", { imageDataUrl: "data:image/png;base64,AAAA" }],
    ["an output format", { output_format: "svg" }],
    ["a prototype key", JSON.parse('{"__proto__": {"model": "x"}}')],
  ])("rejects %s as an unknown argument", (_name, extra) => {
    const result = generateSchema.safeParse({ model: "nano-banana-pro", prompt: "p", out: "o", ...extra })
    expect(result.success).toBe(false)
  })
})

describe("NanoGPT requests", () => {
  test("posts the normalized body with every supported control, asking for PNG", async () => {
    const fetchMock = stubFetch()

    await generate(
      { resolution: "2k", aspect_ratio: "16:9", quality: "xhigh", background: "transparent" },
      "openai/gpt-image-2.5/flare/text-to-image",
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-nano" })
    expect(bodyOf(fetchMock)).toEqual({
      model: "openai/gpt-image-2.5/flare/text-to-image",
      prompt: "a cat",
      n: 1,
      resolution: "2k",
      aspect_ratio: "16:9",
      quality: "xhigh",
      background: "transparent",
      output_format: "png",
    })
  })

  test.each([
    ["Banana Pro", "nano-banana-pro", {}],
    ["Seedream, whose resolution carries an aspect ratio", "bytedance/seedream-v5.0-pro", { resolution: "16:9" }],
  ])("sends only the controls given for %s and requests no output format", async (_name, model, extra) => {
    const fetchMock = stubFetch()

    await generate(extra, model)

    expect(bodyOf(fetchMock)).toEqual({ model, prompt: "a cat", n: 1, ...extra })
  })

  test("sends a seed and a PNG request for Qwen, and omits every control that was not given", async () => {
    const fetchMock = stubFetch()

    await generate({ seed: 7 }, "qwen-image-2.1/text-to-image")

    expect(bodyOf(fetchMock)).toEqual({
      model: "qwen-image-2.1/text-to-image",
      prompt: "a cat",
      n: 1,
      seed: 7,
      output_format: "png",
    })
  })

  test("sends the references of an edit as data URLs in input_references, in order, and no legacy alias", async () => {
    const fetchMock = stubFetch()
    const second = Buffer.concat([PNG_BUFFER, Buffer.from("trailer")])
    await writeFile(path.join(dir, "second.png"), second)

    await edit({ images: ["ref.png", "second.png"], aspect_ratio: "auto" })

    const body = bodyOf(fetchMock)
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT)
    expect(body.input_references).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
      `data:image/png;base64,${second.toString("base64")}`,
    ])
    expect(body.aspect_ratio).toBe("auto")
    for (const field of [
      "images",
      "image_url",
      "imageDataUrl",
      "imageDataUrls",
      "nImages",
      "stream",
      "provider",
      "response_format",
    ]) {
      expect(body).not.toHaveProperty(field)
    }
  })

  // Every model ID that both tools accept, and the edit-only Seedream ID, reaches the provider unchanged.
  test.each([
    ...DUAL_IDS.flatMap((id) => [["imagegen", id] as const, ["imageedit", id] as const]),
    ["imageedit", "bytedance/seedream-v5.0-pro/edit"] as const,
  ])("%s sends the exact model ID %s", async (name, id) => {
    const fetchMock = stubFetch()

    await (name === "imagegen" ? generate({}, id) : edit({}, id))

    expect(bodyOf(fetchMock)).toEqual({
      model: id,
      prompt: name === "imagegen" ? "a cat" : "make it orange",
      n: 1,
      ...(name === "imageedit" ? { input_references: [`data:image/png;base64,${PNG_BASE64}`] } : {}),
    })
  })

  test("a generation request has no reference field", async () => {
    const fetchMock = stubFetch()

    await generate()

    expect(bodyOf(fetchMock)).not.toHaveProperty("input_references")
  })

  test.each(["sk bad", "sk-bad\n", "sk-é"])(
    "refuses a key that cannot be an HTTP header value without quoting it",
    async (bad) => {
      const fetchMock = stubFetch()

      const refused = await run(
        "imagegen",
        { model: "nano-banana-pro", prompt: "p", out: "o.png" },
        { type: "key", key: bad },
      ).catch((caught: Error) => caught)

      expect((refused as Error).message).toBe(
        "The NanoGPT API key contains characters that cannot be sent in an HTTP header.",
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("refuses a credential of another kind before any request", async () => {
    const fetchMock = stubFetch()

    await expect(
      run("imagegen", { model: "nano-banana-pro", prompt: "p", out: "o.png" }, { type: "oauth", access: "tok" }),
    ).rejects.toThrow("The backend needs a key credential but received oauth.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a reference that is not PNG, JPEG or WebP before any request", async () => {
    const fetchMock = stubFetch()
    await writeFile(path.join(dir, "ref.gif"), Buffer.from("GIF89a"))

    await expect(edit({ images: ["ref.gif"] })).rejects.toThrow("unsupported reference image type image/gif")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(dir)).not.toContain("cat.png")
  })
})

describe("NanoGPT provider errors", () => {
  test("report the operation, model, status, code and message, with the key removed", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "resolution 8k is invalid for sk-nano",
              type: "invalid_request_error",
              code: "invalid_resolution",
            },
            code: "invalid_resolution",
          }),
          { status: 400 },
        ),
    )

    const error = await generate({ resolution: "2k" }).catch((caught: Error) => caught)

    expect((error as Error).message).toBe(
      "NanoGPT imagegen (nano-banana-pro) request failed: HTTP 400 invalid_resolution: resolution 8k is invalid for [redacted].",
    )
  })

  test.each([
    [401, "Do not retry; the operator needs to check the NanoGPT key."],
    [403, "Do not retry; the operator needs to check the NanoGPT key."],
    [402, "Do not retry; the account balance or rate limit needs the operator."],
    [429, "Do not retry; the account balance or rate limit needs the operator."],
  ])("tell the agent not to retry HTTP %i", async (status, hint) => {
    const fetchMock = stubFetch(() => new Response("no", { status }))

    const error = await edit().catch((caught: Error) => caught)

    expect((error as Error).message).toBe(
      `NanoGPT imageedit (nano-banana-pro-edit) request failed: HTTP ${status}: no. ${hint}`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("bound a long non-JSON body and never echo the prompt that was sent", async () => {
    stubFetch(() => new Response("x".repeat(5000), { status: 502 }))

    const error = await generate({}, "nano-banana-pro").catch((caught: Error) => caught)

    expect((error as Error).message.length).toBeLessThan(700)
    expect((error as Error).message).not.toContain("a cat")
  })

  // The code is provider text too, wherever the provider puts it.
  test.each([
    ["a nested code", { error: { message: "m", code: "bad-sk-nano-code" }, code: "other" }, "bad-[redacted]-code"],
    ["a top-level code", { code: "bad-sk-nano-code", error: "m" }, "bad-[redacted]-code"],
    ["a code that is the key", { error: { code: "sk-nano" } }, "HTTP 400 [redacted]"],
  ])("remove the key from %s", async (_name, body, shown) => {
    stubFetch(() => new Response(JSON.stringify(body), { status: 400 }))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toContain(shown)
    expect((error as Error).message).not.toContain("sk-nano")
  })

  test("bound a very long code as well as the message", async () => {
    const long = "c".repeat(5000)
    stubFetch(() => new Response(JSON.stringify({ error: { message: long, code: long } }), { status: 400 }))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message.length).toBeLessThan(700)
    expect((error as Error).message).toContain(`HTTP 400 ${"c".repeat(64)}: `)
  })

  test.each([400, 401, 402, 403, 404, 429])("do not claim a possible charge for HTTP %i", async (status) => {
    stubFetch(() => new Response("no", { status }))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).not.toContain("charged")
  })

  test.each([500, 502, 503])("say the account may have been charged after HTTP %i", async (status) => {
    stubFetch(() => new Response("upstream boom", { status }))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toBe(
      `NanoGPT imagegen (nano-banana-pro) request failed: HTTP ${status}: upstream boom. Nothing was saved. NanoGPT may already have charged for this generation.`,
    )
  })
})

describe("NanoGPT responses", () => {
  const fails =
    (body: unknown, message: string, status = 200) =>
    async () => {
      const fetchMock = stubFetch(() => new Response(JSON.stringify(body), { status }))

      const error = await generate().catch((caught: Error) => caught)

      expect((error as Error).message).toContain(message)
      expect((error as Error).message).toContain(
        "Nothing was saved. NanoGPT may already have charged for this generation.",
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await readdir(dir)).toEqual(["ref.png"])
    }

  test(
    "refuses several images instead of saving the first and discarding the rest",
    fails({ data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }] }, "data holds 2 images but one was requested"),
  )
  test(
    "refuses a job description, because the plugin does not poll",
    fails(
      { status: "processing", runId: "run_1" },
      'it describes a pending job (status "processing") instead of an image. This plugin does not poll',
    ),
  )
  test("removes the key from a pending status and bounds it", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: `sk-nano-${"s".repeat(5000)}`, runId: "run_1" })))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toContain('(status "[redacted]-sssss')
    expect((error as Error).message).not.toContain("sk-nano")
    expect((error as Error).message.length).toBeLessThan(500)
  })
  test("refuses a response without data", fails({ created: 1 }, "data holds no image."))
  test("refuses empty data", fails({ data: [] }, "data holds no image."))
  test("refuses an entry with neither field", fails({ data: [{}] }, "neither b64_json nor url"))
  test(
    "refuses an entry with both fields",
    fails({ data: [{ b64_json: PNG_BASE64, url: "https://cdn.example/x.png" }] }, "both b64_json and url"),
  )
  test(
    "refuses image bytes that are not text",
    fails({ data: [{ b64_json: [...PNG_BUFFER] }] }, "not a non-empty string"),
  )
  test("refuses an empty url", fails({ data: [{ url: "" }] }, "data[0].url is not a non-empty string"))
  test("refuses a body that is not an object", fails([1], "the body is not a JSON object"))

  test("refuses a body that is not JSON", async () => {
    stubFetch(() => new Response("<html>", { status: 200 }))

    await expect(generate()).rejects.toThrow("returned a response that is not JSON. Nothing was saved. NanoGPT may")
  })
})

const URL_RESPONSE = () =>
  new Response(JSON.stringify({ data: [{ url: "https://cdn.nano-gpt.example/img/1.png?sig=SECRET" }] }))
const downloadsAfterRequest = (respond: (init: RequestInit) => Response | Promise<Response>) =>
  stubFetch((url, init) => (String(url) === ENDPOINT ? URL_RESPONSE() : respond(init)))

// A rejection that carries what a runtime error can: the request URL, the key and a signed URL, in the message and
// in a cause.
const leaky = (code: string) =>
  Object.assign(new Error("failed https://cdn.nano-gpt.example/img/1.png?sig=SECRET Bearer sk-nano"), {
    code,
    cause: new Error("sig=SECRET"),
  })
const failingBody = (error: Error, first?: Uint8Array) =>
  new Response(
    new ReadableStream({
      start(controller) {
        if (first) controller.enqueue(first)
      },
      pull(controller) {
        controller.error(error)
      },
    }),
  )

describe("NanoGPT transport failures", () => {
  const UNCERTAIN =
    "Nothing was saved. NanoGPT may already have charged for this generation. Do not repeat the call unchanged."

  test.each([
    [
      "the request cannot be sent",
      () => stubFetch(() => Promise.reject(leaky("ECONNRESET"))),
      "NanoGPT imagegen (nano-banana-pro) failed while sending the request.",
      1,
    ],
    [
      "the response cannot be read",
      () => stubFetch(() => failingBody(leaky("EPIPE"))),
      "NanoGPT imagegen (nano-banana-pro) failed while reading the response.",
      1,
    ],
    [
      "the download cannot start",
      () =>
        downloadsAfterRequest(() => {
          throw leaky("ETIMEDOUT")
        }),
      "NanoGPT imagegen (nano-banana-pro) failed while downloading the image.",
      2,
    ],
    [
      "the download stream breaks",
      () => downloadsAfterRequest(() => failingBody(leaky("ECONNABORTED"), PNG_BUFFER.subarray(0, 20))),
      "NanoGPT imagegen (nano-banana-pro) failed while reading the image download.",
      2,
    ],
  ])("reports where it failed, once, when %s", async (_name, stub, summary, requests) => {
    const fetchMock = stub()

    const error = (await generate().catch((caught: Error) => caught)) as Error

    expect(error.message).toBe(`${summary} ${UNCERTAIN}`)
    expect(error.cause).toBeUndefined()
    for (const secret of ["sk-nano", "SECRET", "api.nano-gpt.com", "cdn.nano-gpt.example"]) {
      expect(error.message).not.toContain(secret)
    }
    expect(fetchMock).toHaveBeenCalledTimes(requests)
    expect(await readdir(dir)).toEqual(["ref.png"])
  })

  test("names the tool and model of an edit", async () => {
    stubFetch(() => Promise.reject(leaky("ECONNRESET")))

    const error = (await edit().catch((caught: Error) => caught)) as Error

    expect(error.message).toStartWith("NanoGPT imageedit (nano-banana-pro-edit) failed while sending the request")
  })

  // A runtime error's code or name is runtime text, and a key is a valid identifier, so nothing of either is shown.
  test.each([
    ["a code that is the key", { code: "sk-nano" }],
    ["a code that contains the key", { code: "ERR_sk-nano_FAILED" }],
    ["a name that is the key, with no code", { name: "sk-nano" }],
    ["a name that is the key beside a conventional code", { code: "ECONNRESET", name: "sk-nano" }],
    ["a code and a name that are not identifiers", { code: "sk-nano https://x/?sig=SECRET", name: "" }],
  ])("shows no runtime code or name, however it is spelled: %s", async (_name, fields) => {
    stubFetch(() => Promise.reject(Object.assign(new Error("x"), fields)))

    const error = (await generate().catch((caught: Error) => caught)) as Error

    expect(error.message).toBe(`NanoGPT imagegen (nano-banana-pro) failed while sending the request. ${UNCERTAIN}`)
    for (const secret of ["sk-nano", "SECRET", "ECONNRESET"]) expect(error.message).not.toContain(secret)
  })

  // The provider chooses the download host, so a hostname can spell the key. The download stage is reported with no
  // host and no URL, on every path that reports one.
  describe("when the provider's download host contains the key", () => {
    const KEY_HOST_URL = "https://sk-nano.cdn.example/img?sig=SECRET"
    const keyHostDownload = (respond: (init: RequestInit) => Response | Promise<Response>) =>
      stubFetch((url, init) =>
        String(url) === ENDPOINT ? new Response(JSON.stringify({ data: [{ url: KEY_HOST_URL }] })) : respond(init),
      )

    test.each([
      [
        "the download cannot start",
        () =>
          keyHostDownload(() => {
            throw leaky("ETIMEDOUT")
          }),
        "failed while downloading the image.",
      ],
      [
        "the download stream breaks",
        () => keyHostDownload(() => failingBody(leaky("ECONNABORTED"), PNG_BUFFER.subarray(0, 20))),
        "failed while reading the image download.",
      ],
      [
        "the download answers with an error",
        () => keyHostDownload(() => new Response("no", { status: 403 })),
        "image download failed: HTTP 403.",
      ],
      [
        "the download is empty",
        () => keyHostDownload(() => new Response(null)),
        "image download failed: the response was empty.",
      ],
      [
        "the download is shorter than it declared",
        () => keyHostDownload(() => new Response(PNG_BUFFER, { headers: { "content-length": "999" } })),
        "image download failed: ",
      ],
    ])("reports the stage only when %s", async (_name, stub, expected) => {
      stub()

      const error = (await generate().catch((caught: Error) => caught)) as Error

      expect(error.message).toContain(expected)
      for (const secret of ["sk-nano", "SECRET", "cdn.example"]) expect(error.message).not.toContain(secret)
      expect(error.cause).toBeUndefined()
    })
  })

  test("keeps the cancellation reason when the signal aborted during the body read", async () => {
    const controller = new AbortController()
    downloadsAfterRequest(
      (init) =>
        new Response(
          new ReadableStream({
            start(stream) {
              init.signal?.addEventListener("abort", () => stream.error(init.signal?.reason))
              controller.abort(new Error("stopped while reading"))
            },
          }),
        ),
    )

    const act = run("imagegen", { model: "nano-banana-pro", prompt: "p", out: "dl.png" }, key, controller.signal)

    await expect(act).rejects.toThrow("stopped while reading")
    expect(await readdir(dir)).toEqual(["ref.png"])
  })

  test("keeps the cancellation reason when the signal aborted while the response was read", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch((_url, init) => {
      return new Response(
        new ReadableStream({
          start(stream) {
            controller.abort(new Error("stopped while reading the response"))
            stream.error(init.signal?.reason)
          },
        }),
      )
    })

    const act = run("imagegen", { model: "nano-banana-pro", prompt: "p", out: "dl.png" }, key, controller.signal)

    await expect(act).rejects.toThrow("stopped while reading the response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("NanoGPT image URLs", () => {
  test.each([PNG_BUFFER, JPEG_BUFFER, WEBP_BUFFER])(
    "downloads native bytes without credentials or redirects",
    async (bytes) => {
      const fetchMock = downloadsAfterRequest(() => new Response(bytes))

      const saved = await run("imagegen", { model: "nano-banana-pro", prompt: "p", out: "cat.png" })

      expect(await Bun.file(saved.savedPath).bytes()).toEqual(new Uint8Array(bytes))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [url, init] = fetchMock.mock.calls[1]
      expect(String(url)).toBe("https://cdn.nano-gpt.example/img/1.png?sig=SECRET")
      expect(init.method).toBe("GET")
      expect(init.redirect).toBe("manual")
      expect(init.headers).toBeUndefined()
      expect(JSON.stringify(init)).not.toContain("sk-nano")
    },
  )

  test("a cancelled download rejects and saves nothing", async () => {
    const controller = new AbortController()
    const fetchMock = downloadsAfterRequest(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          controller.abort(new Error("stopped during download"))
        }),
    )

    const act = run("imagegen", { model: "nano-banana-pro", prompt: "p", out: "dl.png" }, key, controller.signal)

    await expect(act).rejects.toThrow("stopped during download")
    expect(fetchMock.mock.calls[1][1].signal?.aborted).toBe(true)
    expect(await readdir(dir)).toEqual(["ref.png"])
  })

  test.each([
    ["an http URL", "http://cdn.example/x.png", "it is not an https URL"],
    ["a URL with credentials", "https://user:pw@cdn.example/x.png", "it contains credentials"],
    ["an IPv4 host", "https://169.254.169.254/latest", "its host is an IP address or localhost"],
    ["a shortened IPv4 host", "https://0x7f.1/x.png", "its host is an IP address or localhost"],
    ["an IPv6 host", "https://[::1]/x.png", "its host is an IP address or localhost"],
    ["localhost", "https://localhost/x.png", "its host is an IP address or localhost"],
    ["localhost with a trailing dot", "https://localhost./x.png", "its host is an IP address or localhost"],
    ["localhost with several trailing dots", "https://localhost../x.png", "its host is an IP address or localhost"],
    ["a localhost subdomain", "https://foo.localhost/x.png", "its host is an IP address or localhost"],
    [
      "a localhost subdomain with a trailing dot",
      "https://foo.localhost./x.png",
      "its host is an IP address or localhost",
    ],
    ["an IPv4 host with a trailing dot", "https://127.0.0.1./x.png", "its host is an IP address or localhost"],
    ["a shortened IPv4 host with a trailing dot", "https://0x7f.1./x.png", "its host is an IP address or localhost"],
    ["an IPv4-mapped IPv6 host", "https://[::ffff:7f00:1]/x.png", "its host is an IP address or localhost"],
    ["a text that is not a URL", "not a url", "it is not a valid URL"],
    ["a data URL", "data:image/png;base64,AAAA", "it is not an https URL"],
  ])("refuses %s without a download request and without repeating the URL", async (_name, url, reason) => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ data: [{ url }] })))

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toContain(`will not download: ${reason}`)
    expect((error as Error).message).not.toContain(url)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test.each([
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x.png" } }),
      "it answered with a redirect (HTTP 302), which is refused",
    ],
    ["an HTTP error", () => new Response("denied", { status: 403 }), "HTTP 403."],
    ["an empty body", () => new Response(null, { status: 200 }), "the response was empty"],
    [
      "a declared size above the limit",
      () => new Response(PNG_BUFFER, { headers: { "content-length": "67108865" } }),
      "the image is 67108865 bytes",
    ],
  ])("reports %s from the download with no host and no URL", async (_name, respond, reason) => {
    const fetchMock = downloadsAfterRequest(respond)

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toContain(`image download failed: ${reason}`)
    expect((error as Error).message).toContain("NanoGPT may already have charged for this generation.")
    expect((error as Error).message).not.toContain("SECRET")
    expect((error as Error).message).not.toContain("cdn.nano-gpt.example")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("stops reading a body that grows past the limit", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    downloadsAfterRequest(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 1
              controller.enqueue(chunk)
            },
          }),
        ),
    )

    const error = await generate().catch((caught: Error) => caught)

    expect((error as Error).message).toContain("larger than the limit of 67108864 bytes")
    expect(sent).toBeLessThan(80)
  })

  test("keeps the size refusal when cancelling the oversize body fails, without the runtime's failure", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    downloadsAfterRequest(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk)
            },
            cancel() {
              throw leaky("ECANCELLED")
            },
          }),
        ),
    )

    const error = (await generate().catch((caught: Error) => caught)) as Error

    expect(error.message).toContain("image download failed: the image is larger than the limit of 67108864 bytes.")
    for (const secret of ["sk-nano", "SECRET", "ECANCELLED"]) expect(error.message).not.toContain(secret)
    expect(error.cause).toBeUndefined()
  })

  // The first bytes of the truncated body are a valid PNG, so only the declared length shows the loss.
  test.each([
    ["no content encoding", {}],
    ["the identity encoding", { "content-encoding": "identity" }],
    ["an identity encoding in capitals", { "content-encoding": " Identity " }],
  ])("refuses a body shorter than its declared length with %s, saving nothing", async (_name, headers) => {
    const declared = PNG_BUFFER.length + 8
    const fetchMock = downloadsAfterRequest(
      () => new Response(PNG_BUFFER, { headers: { "content-length": String(declared), ...headers } }),
    )

    const error = (await generate({ out: "nested/cat.png" }).catch((caught: Error) => caught)) as Error

    expect(error.message).toContain(
      `image download failed: ${PNG_BUFFER.length} bytes arrived but the response declared ${declared}.`,
    )
    expect(error.message).toContain("Nothing was saved. NanoGPT may already have charged for this generation.")
    expect(error.message).not.toContain("SECRET")
    expect(error.message).not.toContain("cdn.nano-gpt.example")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await readdir(dir)).toEqual(["ref.png"])
  })

  test("refuses a body longer than its declared length", async () => {
    downloadsAfterRequest(
      () => new Response(PNG_BUFFER, { headers: { "content-length": String(PNG_BUFFER.length - 1) } }),
    )

    const error = (await generate().catch((caught: Error) => caught)) as Error

    expect(error.message).toContain(
      `${PNG_BUFFER.length} bytes arrived but the response declared ${PNG_BUFFER.length - 1}.`,
    )
    expect(await readdir(dir)).toEqual(["ref.png"])
  })

  // For a compressed representation the length counts encoded bytes and the body is already decoded.
  test.each([
    ["a matching length", { "content-length": String(PNG_BUFFER.length) }],
    ["a compressed representation with the encoded length", { "content-length": "3", "content-encoding": "gzip" }],
    ["a length that is not a number", { "content-length": "abc" }],
    ["an empty length", { "content-length": "" }],
    ["a negative length", { "content-length": "-1" }],
  ])("saves the image for %s", async (_name, headers) => {
    downloadsAfterRequest(() => new Response(PNG_BUFFER, { headers }))

    const saved = await generate()

    expect(await Bun.file(saved.savedPath).bytes()).toEqual(new Uint8Array(PNG_BUFFER))
  })

  test("saves nothing when the downloaded bytes are not an accepted image format", async () => {
    downloadsAfterRequest(() => new Response("<svg/>"))

    const error = await generate({ out: "nested/cat.png" }).catch((caught: Error) => caught)

    expect((error as Error).message).toContain("unsupported image type (unknown)")
    expect(await readdir(dir)).toEqual(["ref.png"])
  })
})

// The tools as the hosts register them. The saved-image behavior of imagegen and imageedit is covered in
// imagegen.test.ts; this covers the information tool, which needs nothing from the host.
describe.each([
  ["OpenCode 1", "v1"],
  ["OpenCode 2", "v2"],
] as const)("imagegen_models through %s", (_host, version) => {
  let fetchMock: ReturnType<typeof stubFetch>
  beforeEach(() => {
    // Nothing may be needed to answer: no key in the store and a failing network. Resolving a credential would fail.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    fetchMock = stubFetch(() => {
      throw new Error("the information tool must not use the network")
    })
  })

  async function ask(args: unknown) {
    if (version === "v1") {
      selectBackendVariable("nano-gpt")
      const hooks = await plugin.server({} as never)
      const asks: unknown[] = []
      const result = (await hooks.tool?.imagegen_models.execute(
        args as never,
        v1ToolContext(dir, new AbortController().signal, async (input) => void asks.push(input)),
      )) as { output: string }
      return { text: result.output, touched: asks }
    }
    const loaded = await loadV2Tool({ directory: dir, backend: "nano-gpt" })
    const result = await loaded.run(args, undefined, undefined, "imagegen_models")
    const { assert, active, resolve, sessionGet } = loaded.calls
    return { text: result.content, touched: [...assert, ...active, ...resolve, ...sessionGet] }
  }

  test("answers from the registry without a permission, credential, session, file or network access", async () => {
    const { text, touched } = await ask({})

    for (const [generateId, editId] of EXPECTED_IDS) {
      expect(text).toContain(`- ${generateId} (`)
      expect(text).toContain(`- ${editId} (`)
    }
    expect(text).toContain("17 of 17 shown; 13 distinct IDs shown")
    expect(text).toContain("Sampled live workflow coverage:")
    expect(touched).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("filters by operation, family and query words", async () => {
    const edit = (await ask({ operation: "edit" })).text
    expect(edit).toContain("9 of 17 shown")
    expect(edit).not.toContain("- nano-banana-pro (")
    expect((await ask({ family: "flux-3" })).text).toContain("2 of 17 shown")
    const transparent = (await ask({ query: "transparent" })).text
    expect((await ask({ operation: "generate", query: "transparent" })).text).toContain("1 distinct ID shown")
    expect(transparent).toContain("openai/gpt-image-2.5/flare/text-to-image")
    expect(transparent).not.toContain("qwen-image")
    expect((await ask({ query: "no-such-word" })).text).toContain("No supported model matches")
  })

  test("describes one model with its values, limits and an argument schema that matches the registry", async () => {
    const model = findModel("edit", "bytedance/seedream-v5.0-pro/edit") as NanoModel

    const { text } = await ask({ model: model.id })

    expect(text).toContain("The generate model of this family is bytedance/seedream-v5.0-pro (imagegen).")
    expect(text).toContain("- resolution: 1:1, 16:9, 9:16, 3:2, 2:3, 4:3, 3:4, 1k, 2k")
    expect(text).toContain("10485760 bytes")
    expect(text).toContain("Sampled live workflow coverage and limits:")
    const schema = JSON.parse(text.slice(text.indexOf("{")))
    expect(schema.tool).toBe("imageedit")
    expect(schema.required).toEqual(["model", "prompt", "out", "images"])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.resolution.enum).toEqual(model.resolutions)
    expect(schema.properties.images.maxItems).toBe(10)
    expect(Object.keys(schema.properties)).toEqual(["model", "prompt", "out", "resolution", "images"])
    expect(schema.properties.images.items).toEqual({ type: "string", minLength: 1 })
  })

  test("gives the FLUX reference pixel note to the edit model only", async () => {
    const edit = (await ask({ model: "black-forest-labs/flux-3/edit" })).text
    const generate = (await ask({ model: "black-forest-labs/flux-3/text-to-image" })).text

    expect(edit).toContain("256 pixels on each side")
    expect(generate).not.toContain("256 pixels")
    expect(generate).toContain("References: none.")
  })

  test.each(DUAL_IDS)("describes both operation schemas for %s", async (id) => {
    const { text } = await ask({ model: id })
    const schemas = JSON.parse(text.slice(text.indexOf("{")))
    expect(Object.keys(schemas)).toEqual(["imagegen", "imageedit"])
    expect(schemas.imagegen.required).toEqual(["model", "prompt", "out"])
    expect(schemas.imageedit.required).toEqual(["model", "prompt", "out", "images"])
    expect(schemas.imagegen.properties.model.const).toBe(id)
    expect(schemas.imageedit.properties.model.const).toBe(id)
    expect(text).toContain(`The edit model of this family is ${id} (imageedit).`)
    if (id === "wan2.7-image-pro") {
      expect(schemas.imagegen.properties.resolution.enum).toContain("4k")
      expect(schemas.imageedit.properties.resolution.enum).not.toContain("4k")
      expect(text).toContain("plugin excludes 4k editing")
    }
  })

  test.each([
    ["an unknown model", { model: "nano-banana-pro-v2" }, "Invalid option"],
    ["a model with a filter", { model: "nano-banana-pro", family: "flux-3" }, "model cannot be combined with"],
    ["an unknown family", { family: "dall-e" }, "at family"],
    ["an unknown argument", { limit: 5 }, 'Unrecognized key: "limit"'],
  ])("rejects %s without the network", async (_name, args, message) => {
    await expect(ask(args)).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("NanoGPT tool guidance", () => {
  const description = (name: string) =>
    nanoGptBackend.tools.find((candidate) => candidate.name === name)?.description ?? ""

  test.each(["imagegen", "imageedit"])(
    "%s tells an agent to pick, justify and escalate a model without per-call approval",
    (name) => {
      const text = description(name)

      expect(text).toContain("use the model the operator named when this tool supports it")
      expect(text).toContain("give a short reason")
      expect(text).toContain("Ask the operator only when required input is missing")
      expect(text).toContain("needs no approval of its own")
      expect(text).toContain("Do not retry authentication, balance or rate-limit errors")
    },
  )

  test("each tool lists only the models of its operation", () => {
    expect(description("imagegen")).toContain("nano-banana-pro (Nano Banana Pro)")
    expect(description("imagegen")).not.toContain("nano-banana-pro-edit")
    expect(description("imageedit")).toContain("nano-banana-pro-edit (Nano Banana Pro)")
  })

  test("names the credential and the recipient of the prompt", () => {
    expect(description("imagegen")).toContain("OC_MULTI_IMAGEGEN_NANOGPT_API_KEY")
    expect(description("imagegen")).toContain("nano-gpt-images")
    expect(description("imagegen")).toContain("the prompt is sent to NanoGPT, which bills the account")
    expect(description("imageedit")).toContain("the prompt and reference images are sent to NanoGPT")
  })

  test("describes native output formats", () => {
    for (const name of ["imagegen", "imageedit"]) {
      expect(description(name)).toContain(
        "Exactly one image is requested; native PNG, JPEG or WebP responses are saved.",
      )
    }
  })
})

// The reference count and file size each edit model takes: the model's own limits, and the route's 31457280 bytes
// where the provider states no lower file size.
describe("NanoGPT model limits", () => {
  const profiles = [
    ["openai/gpt-image-2.5/flare/edit", 16, 31457280],
    ["nano-banana-pro-edit", 10, 31457280],
    ["black-forest-labs/flux-3/edit", 10, 31457280],
    ["bytedance/seedream-v5.0-pro", 10, 10485760],
    ["bytedance/seedream-v5.0-pro/edit", 10, 10485760],
    ["qwen-image-2.1/edit", 10, 31457280],
    ["qwen-image-3-pro", 3, 10485760],
    ["wan2.7-image-pro", 9, 31457280],
    ["meta/muse-image/text-to-image", 10, 31457280],
  ] as const
  test.each(profiles)("%s enforces count and byte boundaries before fetch", async (id, count, bytes) => {
    const fetchMock = stubFetch()
    await edit({ images: Array(count).fill("ref.png") }, id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The largest limit is also the schema's array limit, which refuses an extra reference with its own wording.
    await expect(edit({ images: Array(count + 1).fill("ref.png") }, id)).rejects.toThrow(
      new RegExp(`at most ${count} reference images|expected array to have <=${count} items`),
    )
    const atLimit = Buffer.alloc(bytes)
    PNG_BUFFER.copy(atLimit)
    await writeFile(path.join(dir, "limit.png"), atLimit)
    await edit({ images: ["limit.png"] }, id)
    await writeFile(path.join(dir, "limit.png"), Buffer.concat([atLimit, Buffer.from([0])]))
    await expect(edit({ images: ["limit.png"] }, id)).rejects.toThrow("reference image is too large")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  test.each(["imagegen", "imageedit"])("%s enforces Qwen Unicode prompt boundary", async (name) => {
    const fetchMock = stubFetch()
    const base = { model: "qwen-image-3-pro", out: "o.png", ...(name === "imageedit" ? { images: ["ref.png"] } : {}) }
    await run(name, { ...base, prompt: `  ${"𝔸".repeat(800)}  ` })
    await expect(run(name, { ...base, prompt: "𝔸".repeat(801) })).rejects.toThrow("at most 800")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  test("rejects wrong operations, missing references, unsupported controls and unknown IDs without fetch", async () => {
    const fetchMock = stubFetch()
    for (const [name, extra, message] of [
      [
        "imagegen",
        { model: "bytedance/seedream-v5.0-pro/edit" },
        "bytedance/seedream-v5.0-pro/edit is for imageedit, not imagegen. Use imageedit with it, or imagegen with bytedance/seedream-v5.0-pro.",
      ],
      ["imagegen", { model: "unknown" }, 'Unsupported generate model "unknown"'],
      ["imagegen", { model: "qwen-image-3-pro", seed: 1 }, "seed is not supported by qwen-image-3-pro"],
      [
        "imagegen",
        { model: "meta/muse-image/text-to-image", output_format: "png" },
        "Unsupported argument: output_format",
      ],
      [
        "imagegen",
        { model: "wan2.7-image-pro", aspect_ratio: "1:1" },
        "aspect_ratio is not supported by wan2.7-image-pro",
      ],
      [
        "imageedit",
        { model: "wan2.7-image-pro", images: ["ref.png"], resolution: "4k" },
        'Unsupported resolution "4k" for wan2.7-image-pro',
      ],
      ...DUAL_IDS.map((model) => ["imageedit", { model }, "at images"] as const),
    ] as const) {
      await expect(run(name, { prompt: "p", out: "o.png", ...extra })).rejects.toThrow(message)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
