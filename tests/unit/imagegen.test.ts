import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolateEnvironment, PNG_BASE64, PNG_BUFFER } from "./fixtures"
import {
  ENVIRONMENT_KEY,
  FLAVOURS,
  type Flavour,
  STORED_CREDENTIALS,
  type ToolHarness,
  v1Harness,
  v2Harness,
} from "./hosts"

// The image flow is shared by both host adapters and every backend, so each test runs against OpenCode 1 and
// OpenCode 2 with each backend selected, once for each tool the backend registers that calls the provider.
// Wire-level request details live in codex.test.ts, openai-api.test.ts and nano-gpt.test.ts.
isolateEnvironment()
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(STORED_CREDENTIALS)
  dir = await mkdtemp(path.join(os.tmpdir(), "imagegen-"))
  // The reference image of the calls that edit.
  await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

function imagesResponse(b64Json: string): Response {
  return new Response(JSON.stringify({ created: 0, data: [{ b64_json: b64Json }] }))
}

function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => imagesResponse(PNG_BASE64),
) {
  const fetchMock = mock(async (url: string, init: RequestInit) => respond(url, init))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

type CreateHarness = (directory: string, flavour: Flavour, tool?: string) => Promise<ToolHarness>
const hosts: Array<[string, CreateHarness]> = [
  ["OpenCode 1", v1Harness],
  ["OpenCode 2", v2Harness],
]
const matrix = hosts.flatMap(([host, create]) =>
  FLAVOURS.flatMap((flavour) =>
    flavour.operations.map((operation) => [host, flavour.backend, operation.tool, create, flavour, operation] as const),
  ),
)

// The files the tests did not put there themselves.
const listed = async () => (await readdir(dir)).filter((name) => name !== "ref.png")

describe.each(matrix)("%s with the %s backend calling %s", (_host, _backend, _tool, create, flavour, operation) => {
  const args = operation.args
  const createHarness = (directory: string) => create(directory, flavour, operation.tool)

  test("saves the generated image under the host directory and reports it", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    const result = await harness.execute(args)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      message: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      out: savedPath,
      versioned: false,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(operation.url)
    expect((init.headers as Record<string, string>).Authorization).toBe(flavour.authorization)
  })

  test("versions the output path when it already exists", async () => {
    stubFetch()
    const harness = await createHarness(dir)
    await harness.execute(args)

    const second = await harness.execute(args)

    expect(second.out).toBe(path.join(dir, "cat-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toContain("the requested path")
  })

  // Codex and the OpenAI Images API keep their original contract: an argument they do not define is dropped.
  if (flavour.dropsUnknownArguments) {
    test("drops arguments it does not define", async () => {
      const fetchMock = stubFetch()
      const harness = await createHarness(dir)

      await harness.execute({ ...args, output_format: "jpeg", n: 4 })

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.n).not.toBe(4)
      expect(body.output_format).not.toBe("jpeg")
    })
  }

  test("treats optional arguments that are null as omitted", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    // Some models fill unused optional arguments with null.
    await harness.execute({ ...args, ...operation.nulls })

    expect(fetchMock.mock.calls[0][0]).toBe(operation.url)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toMatchObject(operation.nullBody)
    for (const field of operation.absentWhenNull) expect(body).not.toHaveProperty(field)
  })

  test.each(operation.invalid)(
    "rejects %s before asking permission or calling the backend",
    async (_name, invalid, message) => {
      const fetchMock = stubFetch()
      const harness = await createHarness(dir)

      await expect(harness.execute(invalid)).rejects.toThrow(message)

      expect(harness.permissionRequests).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("asks permission once for the whole operation before calling the backend", async () => {
    const harness = await createHarness(dir)
    const fetchMock = stubFetch(() => {
      expect(harness.permissionRequests).toHaveLength(1)
      return imagesResponse(PNG_BASE64)
    })

    await harness.execute(args)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.permissionRequests).toHaveLength(1)
  })

  test("a denied permission stops before credentials, reference images or the backend are touched", async () => {
    // Reaching the credential store or the key variable would fail with a different error than the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ""
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    harness.denyPermission(new Error("denied by the host"))

    // The reference image does not exist: reading it first would fail with a different error. A tool that takes no
    // references has none to read.
    const act = harness.execute(operation.tool === flavour.editTool ? { ...args, images: ["missing.png"] } : args)

    await expect(act).rejects.toThrow("denied by the host")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, "cat.png"))).toBe(false)
  })

  test("forwards the cancellation signal to the provider request", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()

    await harness.execute(args, controller.signal)

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  test("does nothing when the call is cancelled before it starts", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()
    controller.abort(new Error("stopped before start"))

    const act = harness.execute(args, controller.signal)

    await expect(act).rejects.toThrow("stopped before start")
    expect(harness.permissionRequests).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("cancelling during the provider request rejects without retrying or saving", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          controller.abort(new Error("stopped during request"))
        }),
    )
    const harness = await createHarness(dir)

    const act = harness.execute(args, controller.signal)

    await expect(act).rejects.toThrow("stopped during request")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listed()).toEqual([])
  })

  test("does not save an image whose request finished after cancellation", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch(() => {
      controller.abort(new Error("stopped after response"))
      return imagesResponse(PNG_BASE64)
    })
    const harness = await createHarness(dir)

    const act = harness.execute(args, controller.signal)

    await expect(act).rejects.toThrow("stopped after response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listed()).toEqual([])
  })

  test("propagates a provider failure once, without saving or trying another backend", async () => {
    const fetchMock = stubFetch(() => new Response("upstream boom", { status: 500 }))
    const harness = await createHarness(dir)

    const act = harness.execute(args)

    await expect(act).rejects.toThrow(operation.failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listed()).toEqual([])
  })

  test("saves nothing, not even the output directory, when the backend returns data that is not a PNG", async () => {
    stubFetch(() => imagesResponse(Buffer.from("not an image").toString("base64")))
    const harness = await createHarness(dir)

    const act = harness.execute({ ...args, out: "nested/cat.png" })

    await expect(act).rejects.toThrow("not a PNG")
    expect(await listed()).toEqual([])
  })

  // Buffer.from decodes an array or a serialized Buffer, so the PNG bytes below would pass the PNG check if the
  // response boundary accepted them. An empty image would otherwise write a 0-byte file.
  const malformedResponses: Array<[string, unknown]> = [
    ["no image", { data: [] }],
    ["an empty image", { data: [{ b64_json: "" }] }],
    ["a null body", null],
    ["a numeric array of PNG bytes", { data: [{ b64_json: [...PNG_BUFFER] }] }],
    ["a serialized Buffer of PNG bytes", { data: [{ b64_json: { type: "Buffer", data: [...PNG_BUFFER] } }] }],
  ]
  test.each(malformedResponses)(
    "rejects %s from the backend after one request, saving nothing, not even the output directory",
    async (_name, body) => {
      const fetchMock = stubFetch(() => new Response(JSON.stringify(body)))
      const harness = await createHarness(dir)

      const act = harness.execute({ ...args, out: "nested/cat.png" })

      await expect(act).rejects.toThrow(operation.unusableResponse)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await listed()).toEqual([])
    },
  )
})

// The reference images of a call that edits, as the host adapters read them from the project directory.
const flavourRows = hosts.flatMap(([host, create]) =>
  FLAVOURS.map((flavour) => [host, flavour.backend, create, flavour] as const),
)

describe.each(flavourRows)("reference images through %s with the %s backend", (_host, _backend, create, flavour) => {
  test("are sent to the editing endpoint in the order given", async () => {
    const fetchMock = stubFetch()
    const second = Buffer.concat([PNG_BUFFER, Buffer.from("trailer")])
    await Bun.write(path.join(dir, "first.png"), PNG_BUFFER)
    await Bun.write(path.join(dir, "second.png"), second)
    const harness = await create(dir, flavour, flavour.editTool)

    await harness.execute(flavour.editArgs(["first.png", "second.png"]))

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.editsUrl)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(flavour.editReferences(body)).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
      `data:image/png;base64,${second.toString("base64")}`,
    ])
  })
})

const keyFlavours = FLAVOURS.filter((flavour) => flavour.key)
const keyRows = hosts.flatMap(([host, create]) =>
  keyFlavours.map((flavour) => [host, flavour.backend, create, flavour] as const),
)
const codexFlavour = FLAVOURS.find((flavour) => flavour.backend === "codex") as Flavour

// The saved key of each backend is in each host's own store (STORED_CREDENTIALS, and the OpenCode 2 fake connection
// store). OpenCode lists a saved credential before an environment variable, so these tests also show the plugin does
// not take the saved key when the variable is present.
describe.each(keyRows)("API key source through %s with the %s backend", (_host, _backend, create, flavour) => {
  const { variable, saved } = flavour.key as NonNullable<Flavour["key"]>
  const args = flavour.operations[0].args
  const authorizations = (fetchMock: ReturnType<typeof stubFetch>) =>
    fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)

  test(`uses ${variable} ahead of the saved key, and the next call after it changes`, async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)

    process.env[variable] = ENVIRONMENT_KEY
    await harness.execute(args)
    process.env[variable] = "sk-rotated"
    await harness.execute({ ...args, out: "second.png" })
    delete process.env[variable]
    await harness.execute({ ...args, out: "third.png" })

    expect(authorizations(fetchMock)).toEqual([`Bearer ${ENVIRONMENT_KEY}`, "Bearer sk-rotated", `Bearer ${saved}`])
  })

  test.each([
    ["is empty", "", "is set but empty"],
    ["cannot be an HTTP header value", "sk bad\nkey", "contains characters that cannot be sent in an HTTP header"],
  ])("fails when the variable %s, without using the saved key or sending a request", async (_name, value, message) => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    process.env[variable] = value

    const error = await harness.execute(args).catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain("sk bad")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a rejected request is reported once, without a second request with the saved key", async () => {
    const fetchMock = stubFetch(() => new Response("denied", { status: 401 }))
    const harness = await create(dir, flavour)
    process.env[variable] = ENVIRONMENT_KEY

    await expect(harness.execute(args)).rejects.toThrow("401")

    expect(authorizations(fetchMock)).toEqual([`Bearer ${ENVIRONMENT_KEY}`])
  })

  test("ignores the variable of every other backend", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    for (const other of keyFlavours) {
      if (other !== flavour) process.env[(other.key as NonNullable<Flavour["key"]>).variable] = ENVIRONMENT_KEY
    }

    await harness.execute(args)

    expect(authorizations(fetchMock)).toEqual([`Bearer ${saved}`])
  })
})

describe.each(hosts)("the Codex backend through %s", (_host, create) => {
  test("ignores every image API key variable and keeps its ChatGPT sign-in", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, codexFlavour)
    for (const flavour of keyFlavours)
      process.env[(flavour.key as NonNullable<Flavour["key"]>).variable] = ENVIRONMENT_KEY

    await harness.execute(codexFlavour.operations[0].args)

    expect(fetchMock.mock.calls[0][0]).toBe(codexFlavour.operations[0].url)
    expect(fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      codexFlavour.authorization,
    ])
  })
})

describe.each(flavourRows)("backend choice through %s with the %s backend", (_host, _backend, create, flavour) => {
  test("stays the backend the plugin loaded with when the variable changes later", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    process.env.OC_MULTI_IMAGEGEN_BACKEND = flavour.backend === "codex" ? "openai-api" : "codex"

    await harness.execute(flavour.operations[0].args)

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.operations[0].url)
  })
})
