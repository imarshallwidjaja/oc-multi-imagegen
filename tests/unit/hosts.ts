import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import type { HostGenerateImageInput, HostGenerateImageResult, HostImageModel } from "../../src/credential"
import plugin from "../../src/index"
import { CONTROL_NAMES } from "../../src/nano-gpt-models"
import type { resultSchema } from "../../src/schema"
import type { ToolSchema } from "../../src/types"
import { PNG_BASE64 } from "./fixtures"

// Test doubles for the two host contracts. They stand in for OpenCode 1's ToolContext and
// OpenCode 2's plugin Context; the adapters under test never import either SDK at runtime.

// The backends and what is specific to each in these tests. Shared host behavior runs against all of them.
export type Backend = "codex" | "openai-api" | "nano-gpt"

// One tool call the shared tests make against a backend.
export type Operation = {
  tool: string
  // The provider endpoint the call posts to.
  url: string
  // Valid arguments. A call that edits names `ref.png`, which the shared tests create in the project directory.
  args: Record<string, unknown>
  // Arguments the tool rejects, each with a part of the error message.
  invalid: Array<[string, Record<string, unknown>, string]>
  // Optional arguments a model may fill with null, which must behave like omitted ones.
  nulls: Record<string, null>
  // What the request body holds, and which fields it must not hold, when the optional arguments are null.
  nullBody: Record<string, unknown>
  absentWhenNull: string[]
  // Valid arguments that ask for a transparent background.
  transparentArgs: Record<string, unknown>
  // The provider failure message for an HTTP 500 answering "upstream boom".
  failure: string
  // The message for a provider answer that holds no usable image.
  unusableResponse: string
  // Whether the tool also saves GIF and SVG (true) or only PNG, JPEG and WebP (false).
  savesGifAndSvg: boolean
}

export type Flavour = {
  backend: Backend
  authorization: string
  // The permission resource the host is asked for.
  resource: string
  // The credential provider id it reads from the OpenCode credential store.
  provider: string
  // The tools the shared tests call: imagegen, then imageedit.
  operations: [generation: Operation, edit: Operation]
  // The reference data URLs of an editing request body, in order.
  editReferences: (body: Record<string, unknown>) => string[]
  // For a key credential: the variable that overrides the saved key, and the saved key itself.
  key?: { variable: string; saved: string; label: string }
}

// The saved credentials both fake hosts hold: OpenCode 1's STORED_CREDENTIALS and OpenCode 2's connection store. The
// expected Authorization headers use the same values; ENVIRONMENT_KEY differs from both keys, so a request still shows
// which source it used.
const SAVED_CHATGPT_ACCESS = "tok"
const SAVED_IMAGES_KEY = "sk-images"
const SAVED_NANO_KEY = "sk-nano"

const imagesReferences = (body: Record<string, unknown>) =>
  (body.images as Array<{ image_url: string }> | undefined)?.map((image) => image.image_url) ?? []

// A size both Codex and the OpenAI Images API accept.
export const SHARED_SIZE = "1536x1024"
const GENERATE_ARGS = { prompt: "a cat", out: "cat.png", size: SHARED_SIZE }
const EDIT_ARGS = { ...GENERATE_ARGS, prompt: "make the cat orange", images: ["ref.png"] }

const without = (args: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(args).filter(([name]) => name !== key))

// What both image tools of Codex and the OpenAI Images API reject, given each tool's valid arguments.
const sharedInvalid = (args: Record<string, unknown>, tool: string): Operation["invalid"] => [
  ["an unsupported background", { ...args, background: "auto" }, "at background"],
  ["a missing prompt", without(args, "prompt"), "at prompt"],
  ["an empty model", { ...args, model: "" }, "at model"],
  ["a non-string quality", { ...args, quality: 3 }, "at quality"],
  ["a missing size", without(args, "size"), "Missing size"],
  ["an unknown argument", { ...args, n: 4 }, `Unsupported argument: n. ${tool} accepts:`],
]

// A generation call that passes references in any form is refused, so it never generates a different image.
const GENERATION_INVALID: Operation["invalid"] = [
  ...sharedInvalid(GENERATE_ARGS, "imagegen"),
  ["reference images", { ...GENERATE_ARGS, images: ["ref.png"] }, "use imageedit"],
  ["an empty reference list", { ...GENERATE_ARGS, images: [] }, "use imageedit"],
  ["a null reference list", { ...GENERATE_ARGS, images: null }, "use imageedit"],
]

const editInvalid = (maxImages: number): Operation["invalid"] => [
  ...sharedInvalid(EDIT_ARGS, "imageedit"),
  ["no reference image", { ...EDIT_ARGS, images: [] }, "needs at least one reference image"],
  ["a missing reference list", without(EDIT_ARGS, "images"), "Missing images"],
  ["a null reference list", { ...EDIT_ARGS, images: null }, "Missing images"],
  ["an empty reference path", { ...EDIT_ARGS, images: [""] }, "at images"],
  [
    "too many references",
    { ...EDIT_ARGS, images: Array(maxImages + 1).fill("ref.png") },
    `takes at most ${maxImages} reference images`,
  ],
]

const NULLS: Record<string, null> = { background: null, model: null, quality: null, preview: null }

function imagesApiOperation(
  tool: string,
  url: string,
  label: string,
  args: Record<string, unknown>,
  invalid: Operation["invalid"],
): Operation {
  return {
    tool,
    url,
    args,
    invalid,
    nulls: NULLS,
    nullBody: { background: "opaque" },
    absentWhenNull: ["preview"],
    transparentArgs: { ...args, background: "transparent" },
    failure: `${label} images request failed: 500 upstream boom`,
    unusableResponse: `no image returned by ${label} images endpoint`,
    savesGifAndSvg: false,
  }
}

// The OpenAI Images API adds output controls whose combinations are checked before permission or any request. GIF and
// SVG come only from generation, so imageedit refuses their format and controls.
const OPENAI_NULLS = { ...NULLS, output_format: null }
const openaiGeneration: Operation = {
  ...imagesApiOperation("imagegen", "https://api.openai.com/v1/images/generations", "openai-api", GENERATE_ARGS, [
    ...GENERATION_INVALID,
    ["an unknown output format", { ...GENERATE_ARGS, output_format: "bmp" }, "at output_format"],
    ["frame_count without GIF output", { ...GENERATE_ARGS, frame_count: 4 }, "at frame_count"],
    ["frame_count above the tool limit", { ...GENERATE_ARGS, output_format: "gif", frame_count: 17 }, "at frame_count"],
    ["a fractional frame_count", { ...GENERATE_ARGS, output_format: "gif", frame_count: 2.5 }, "at frame_count"],
    [
      "frame_duration_ms below the tool limit",
      { ...GENERATE_ARGS, output_format: "gif", frame_duration_ms: 10 },
      "at frame_duration_ms",
    ],
    [
      "frame_duration_ms with SVG output",
      { ...GENERATE_ARGS, output_format: "svg", frame_duration_ms: 100 },
      "at frame_duration_ms",
    ],
    ["svg_model without SVG output", { ...GENERATE_ARGS, output_format: "gif", svg_model: "author" }, "at svg_model"],
    ["an empty svg_model", { ...GENERATE_ARGS, output_format: "svg", svg_model: "" }, "at svg_model"],
    ["a transparent JPEG", { ...GENERATE_ARGS, output_format: "jpeg", background: "transparent" }, "at background"],
    ["a transparent GIF", { ...GENERATE_ARGS, output_format: "gif", background: "transparent" }, "at background"],
  ]),
  nulls: { ...OPENAI_NULLS, frame_count: null, frame_duration_ms: null, svg_model: null },
  nullBody: { background: "opaque", output_format: "png" },
  absentWhenNull: ["frame_count", "frame_duration_ms", "svg", "preview"],
  savesGifAndSvg: true,
}

const GENERATION_ONLY = "GIF and SVG output come only from imagegen"
const openaiEdit: Operation = {
  ...imagesApiOperation("imageedit", "https://api.openai.com/v1/images/edits", "openai-api", EDIT_ARGS, [
    ...editInvalid(16),
    ["GIF output", { ...EDIT_ARGS, output_format: "gif" }, `output_format gif is generation-only`],
    ["SVG output", { ...EDIT_ARGS, output_format: "svg" }, `output_format svg is generation-only`],
    ["an unknown output format", { ...EDIT_ARGS, output_format: "bmp" }, "at output_format"],
    ["frame_count", { ...EDIT_ARGS, frame_count: 4 }, `Unsupported argument: frame_count. ${GENERATION_ONLY}`],
    [
      "frame_duration_ms",
      { ...EDIT_ARGS, frame_duration_ms: 150 },
      `Unsupported argument: frame_duration_ms. ${GENERATION_ONLY}`,
    ],
    ["svg_model", { ...EDIT_ARGS, svg_model: "author" }, `Unsupported argument: svg_model. ${GENERATION_ONLY}`],
    ["a transparent JPEG", { ...EDIT_ARGS, output_format: "jpeg", background: "transparent" }, "at background"],
  ]),
  nulls: { ...OPENAI_NULLS, mask: null },
  nullBody: { background: "opaque", output_format: "png" },
  absentWhenNull: ["frame_count", "frame_duration_ms", "svg", "preview", "mask"],
}

const NANO_URL = "https://api.nano-gpt.com/api/v1/images"
const NANO_ABSENT = [...CONTROL_NAMES, "preview"]
const NANO_NULLS = Object.fromEntries(NANO_ABSENT.map((name) => [name, null]))
const NANO_UNUSABLE = "returned a response this plugin cannot use"
const nanoReferences = (body: Record<string, unknown>) => (body.input_references as string[] | undefined) ?? []

export const NANO_GENERATE_ARGS = { model: "nano-banana-pro", prompt: "a cat", out: "cat.png" }
export const NANO_EDIT_ARGS = {
  model: "nano-banana-pro-edit",
  prompt: "make the cat orange",
  out: "cat.png",
  images: ["ref.png"],
}

export const FLAVOURS: Flavour[] = [
  {
    backend: "codex",
    authorization: `Bearer ${SAVED_CHATGPT_ACCESS}`,
    resource: "codex",
    provider: "openai",
    operations: [
      imagesApiOperation(
        "imagegen",
        "https://chatgpt.com/backend-api/codex/images/generations",
        "codex",
        GENERATE_ARGS,
        GENERATION_INVALID,
      ),
      imagesApiOperation(
        "imageedit",
        "https://chatgpt.com/backend-api/codex/images/edits",
        "codex",
        EDIT_ARGS,
        editInvalid(5),
      ),
    ],
    editReferences: imagesReferences,
  },
  {
    backend: "openai-api",
    authorization: `Bearer ${SAVED_IMAGES_KEY}`,
    resource: "openai-api",
    provider: "openai-images",
    operations: [openaiGeneration, openaiEdit],
    editReferences: imagesReferences,
    key: { variable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY", saved: SAVED_IMAGES_KEY, label: "OpenAI Images API" },
  },
  {
    backend: "nano-gpt",
    authorization: `Bearer ${SAVED_NANO_KEY}`,
    resource: "nano-gpt",
    provider: "nano-gpt-images",
    operations: [
      {
        tool: "imagegen",
        url: NANO_URL,
        args: NANO_GENERATE_ARGS,
        invalid: [
          ["a control the model does not take", { ...NANO_GENERATE_ARGS, quality: "high" }, "at quality"],
          ["an unknown model", { ...NANO_GENERATE_ARGS, model: "nano-banana" }, "at model"],
          ["an edit model", { ...NANO_GENERATE_ARGS, model: "nano-banana-pro-edit" }, "is for imageedit, not imagegen"],
          ["a missing model", { prompt: "a cat", out: "cat.png" }, "Missing model"],
          ["a missing prompt", { model: "nano-banana-pro", out: "cat.png" }, "at prompt"],
          ["reference images", { ...NANO_GENERATE_ARGS, images: ["ref.png"] }, "use imageedit"],
          ["an unknown argument", { ...NANO_GENERATE_ARGS, n: 4 }, "Unsupported argument: n"],
        ],
        nulls: NANO_NULLS,
        nullBody: { model: "nano-banana-pro", n: 1 },
        absentWhenNull: NANO_ABSENT,
        transparentArgs: {
          ...NANO_GENERATE_ARGS,
          model: "openai/gpt-image-2.5/flare/text-to-image",
          background: "transparent",
        },
        failure: "NanoGPT imagegen (nano-banana-pro) request failed: HTTP 500: upstream boom.",
        unusableResponse: NANO_UNUSABLE,
        savesGifAndSvg: false,
      },
      {
        tool: "imageedit",
        url: NANO_URL,
        args: NANO_EDIT_ARGS,
        invalid: [
          ["no reference image", { ...NANO_EDIT_ARGS, images: [] }, "needs at least one reference image"],
          ["a missing reference list", { model: "nano-banana-pro-edit", prompt: "p", out: "cat.png" }, "at images"],
          ["a generation model", { ...NANO_EDIT_ARGS, model: "nano-banana-pro" }, "is for imagegen, not imageedit"],
          ["too many references for the model", { ...NANO_EDIT_ARGS, images: Array(11).fill("ref.png") }, "at most 10"],
          ["a control the model does not take", { ...NANO_EDIT_ARGS, seed: 1 }, "at seed"],
          ["an unknown argument", { ...NANO_EDIT_ARGS, n: 4 }, "Unsupported argument: n"],
        ],
        nulls: NANO_NULLS,
        nullBody: { model: "nano-banana-pro-edit", n: 1 },
        absentWhenNull: NANO_ABSENT,
        transparentArgs: { ...NANO_EDIT_ARGS, model: "openai/gpt-image-2.5/flare/edit", background: "transparent" },
        failure: "NanoGPT imageedit (nano-banana-pro-edit) request failed: HTTP 500: upstream boom.",
        unusableResponse: NANO_UNUSABLE,
        savesGifAndSvg: false,
      },
    ],
    editReferences: nanoReferences,
    key: { variable: "OC_MULTI_IMAGEGEN_NANOGPT_API_KEY", saved: SAVED_NANO_KEY, label: "NanoGPT API" },
  },
]

// Selects the backend the way a deployment does, through the environment of the process that loads the plugin.
// Codex is the default, so it is the variable's absence.
export function selectBackendVariable(backend: Backend | "opencode" | undefined): void {
  if (backend === undefined || backend === "codex") delete process.env.OC_MULTI_IMAGEGEN_BACKEND
  else process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
}

// The image API key as the environment variable carries it, distinct from every saved key.
export const ENVIRONMENT_KEY = "sk-from-environment"

// OpenCode 1's stored credentials for every backend: the chat provider's ChatGPT sign-in and the image keys.
export const STORED_CREDENTIALS = {
  openai: { type: "oauth", access: SAVED_CHATGPT_ACCESS, refresh: "refresh", expires: 4102444800000 },
  "openai-images": { type: "api", key: SAVED_IMAGES_KEY },
  "nano-gpt-images": { type: "api", key: SAVED_NANO_KEY },
}

// An information tool saves nothing, so `out` and `versioned` are absent for it.
export type NormalizedResult = { message: string; out?: string; versioned?: boolean }

// The file parts an OpenCode 2 result attaches next to its text.
export type FilePart = { type: "file"; uri: string; mime: string; name?: string }
export type V2Content = string | Array<{ type: "text"; text: string } | FilePart>

export type ToolHarness = {
  // Every permission request the adapter made, in the host's own request shape, web fetches included.
  permissionRequests: unknown[]
  // The URLs of the webfetch permission requests, in order.
  webfetchUrls: () => string[]
  // Makes the next permission requests fail as a host denial would.
  denyPermission: (error: Error) => void
  // Makes the next webfetch permission requests fail, leaving the tool's own permission allowed.
  denyWebfetch: (error: Error) => void
  execute: (rawArgs: unknown, signal?: AbortSignal) => Promise<NormalizedResult>
}

const SESSION_ID = "ses_test"

// The tool definition OpenCode 2 receives from the adapter, as far as the tests inspect it.
export type RegisteredTool = {
  name: string
  description: string
  options: Record<string, unknown>
  input: ToolSchema
  output: typeof resultSchema
  execute: (
    input: unknown,
    context: ReturnType<typeof v2ToolContext>,
  ) => Promise<{
    output: { out: string; versioned: boolean; message: string }
    content: V2Content
    metadata: { out: string; versioned: boolean }
  }>
}

type SkillEditor = {
  get: (id: string) => Record<string, unknown> | undefined
  add: (skill: Record<string, unknown>) => void
}

export type V2Options = {
  // Directory returned for any session; override per call with sessionDirectories.
  directory?: string
  sessionDirectories?: Record<string, string>
  // The backend variable of the process; none selects Codex.
  backend?: Backend | "opencode"
  // Plugin options as the host passes them: backend or backends.
  pluginOptions?: unknown
  // The image models ctx.model.list reports, or how it answers, and how ctx.experimental.generate.image answers. False
  // models a host without either.
  imageModels?: HostImageModel[] | (() => Promise<HostImageModel[]>)
  // True models OpenCode 2.3.2, whose ctx.model.list ignores the request's signal.
  modelListIgnoresSignal?: true
  generateImage?: (input: HostGenerateImageInput) => Promise<HostGenerateImageResult>
  hostImageApi?: false
  // The OpenAI integration's connection and credential. Another integration is only present when `integrations`
  // names it.
  connection?: unknown
  credential?: unknown
  // Connections and credentials by integration id, in addition to the defaults below.
  integrations?: Record<string, { connection?: unknown; credential?: unknown }>
  activeError?: Error
  resolveError?: Error
  // Skills the host already holds, keyed by id, such as one the user installed.
  existingSkills?: Record<string, unknown>
  // False models a host that never delivers the skill transform, for example because skills are unavailable.
  skills?: boolean
}

export const CHATGPT_BROWSER_CREDENTIAL = {
  type: "oauth",
  methodID: "chatgpt-browser",
  refresh: "refresh",
  access: SAVED_CHATGPT_ACCESS,
  expires: Number.MAX_SAFE_INTEGER,
}

type RequestOptions = { signal?: AbortSignal }

// Like the host's API methods, a call with an aborted signal rejects before it starts, and an abort during the call
// rejects it with the signal's reason.
function hostRequest<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) return run()
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort))
  })
}

export function createV2Context(options: V2Options = {}) {
  const calls = {
    assert: [] as Array<Record<string, unknown>>,
    sessionGet: [] as Array<{ sessionID: string }>,
    active: [] as string[],
    resolve: [] as unknown[],
    modelList: [] as unknown[],
    generateImage: [] as HostGenerateImageInput[],
    // The request options of each call to the methods above that take them, in call order.
    requestOptions: {
      sessionGet: [] as Array<RequestOptions | undefined>,
      modelList: [] as Array<RequestOptions | undefined>,
      generateImage: [] as Array<RequestOptions | undefined>,
    },
  }
  // Like the host, each integration has its own connection and credential; an unknown integration has none.
  const store: Record<string, { connection?: unknown; credential?: unknown }> = {
    openai: {
      connection: "connection" in options ? options.connection : { type: "credential", id: "cred_1", method: "oauth" },
      credential: "credential" in options ? options.credential : CHATGPT_BROWSER_CREDENTIAL,
    },
    "openai-images": {
      connection: { type: "credential", id: "cred_2", method: "key" },
      credential: { type: "key", key: SAVED_IMAGES_KEY },
    },
    "nano-gpt-images": {
      connection: { type: "credential", id: "cred_3", method: "key" },
      credential: { type: "key", key: SAVED_NANO_KEY },
    },
    ...options.integrations,
  }
  const integrations = new Map<string, { name: string }>()
  const integrationMethods: Array<{ integrationID: string; method: { type: string; names?: string[] } }> = []
  const registered: RegisteredTool[] = []
  const namespaces: Array<{ name: string; description: string }> = []
  const skills = new Map<string, Record<string, unknown>>(Object.entries(options.existingSkills ?? {}) as never)
  const skillCallbacks: Array<(editor: SkillEditor) => void> = []
  // Like the host, adding an id that is already held is an error.
  const skillEditor: SkillEditor = {
    get: (id) => skills.get(id),
    add: (skill) => {
      if (skills.has(skill.id as string)) throw new Error(`Skill ${skill.id} already exists`)
      skills.set(skill.id as string, skill)
    },
  }
  let denial: Error | undefined
  let webfetchDenial: Error | undefined
  const context = {
    // A directory the adapter must not use: sessions carry their own location.
    location: { directory: "/plugin-load-directory" },
    options: "pluginOptions" in options ? options.pluginOptions : {},
    tool: {
      transform: async (
        callback: (editor: {
          add: (tool: RegisteredTool) => void
          namespace: (namespace: { name: string; description: string }) => void
        }) => void,
      ) => {
        callback({ add: (tool) => registered.push(tool), namespace: (namespace) => namespaces.push(namespace) })
        return { dispose: async () => {} }
      },
    },
    skill: {
      transform: async (callback: (editor: SkillEditor) => void) => {
        skillCallbacks.push(callback)
        if (options.skills !== false) callback(skillEditor)
        return { dispose: async () => {} }
      },
    },
    ...(options.hostImageApi === false
      ? {}
      : {
          experimental: {
            generate: {
              image: (input: HostGenerateImageInput, requestOptions?: RequestOptions) => {
                calls.generateImage.push(input)
                calls.requestOptions.generateImage.push(requestOptions)
                return hostRequest(requestOptions?.signal, async () =>
                  options.generateImage
                    ? options.generateImage(input)
                    : { images: [{ type: "image", data: PNG_BASE64, mime: "image/png" }] },
                )
              },
            },
          },
          model: {
            list: (input: unknown, requestOptions?: RequestOptions) => {
              calls.modelList.push(input)
              calls.requestOptions.modelList.push(requestOptions)
              const { imageModels = [] } = options
              return hostRequest(options.modelListIgnoresSignal ? undefined : requestOptions?.signal, async () => ({
                location: {},
                data: typeof imageModels === "function" ? await imageModels() : imageModels,
              }))
            },
          },
        }),
    permission: {
      assert: async (input: Record<string, unknown>) => {
        calls.assert.push(input)
        if (input.action === "webfetch" && webfetchDenial) throw webfetchDenial
        if (denial) throw denial
      },
    },
    session: {
      get: (input: { sessionID: string }, requestOptions?: RequestOptions) => {
        calls.sessionGet.push(input)
        calls.requestOptions.sessionGet.push(requestOptions)
        return hostRequest(requestOptions?.signal, async () => ({
          location: { directory: options.sessionDirectories?.[input.sessionID] ?? options.directory },
        }))
      },
    },
    integration: {
      // Like the host, updating an integration that does not exist yet creates it.
      transform: async (
        callback: (editor: {
          update: (id: string, update: (integration: { name: string }) => void) => void
          method: { update: (input: unknown) => void }
        }) => void,
      ) => {
        callback({
          update: (id, update) => {
            const integration = integrations.get(id) ?? { name: id }
            update(integration)
            integrations.set(id, integration)
          },
          method: { update: (input) => integrationMethods.push(input as (typeof integrationMethods)[number]) },
        })
        return { dispose: async () => {} }
      },
      connection: {
        // Answers with the saved connection only. The plugin resolves an environment key by name and never discovers it
        // here, because the host lists a saved credential before an environment connection.
        active: async (integrationID: string) => {
          calls.active.push(integrationID)
          if (options.activeError) throw options.activeError
          return store[integrationID]?.connection
        },
        resolve: async (connection: unknown) => {
          calls.resolve.push(connection)
          if (options.resolveError) throw options.resolveError
          // A connection a test placed in the store answers with the credential it was given.
          const entry = Object.values(store).find((candidate) => candidate.connection === connection)
          const environment = connection as { type?: string; name?: string }
          if (!entry && environment.type === "env") {
            const key = process.env[environment.name ?? ""]
            return key ? { type: "key", key } : undefined
          }
          if (!entry) throw new Error("the fake host does not know this connection")
          return entry.credential
        },
      },
    },
  }
  return {
    context: context as unknown as Plugin.Context,
    calls,
    registered,
    namespaces,
    integrations,
    integrationMethods,
    skills,
    // Runs every skill callback again against the skills the host already holds.
    replaySkills: () => {
      for (const callback of skillCallbacks) callback(skillEditor)
    },
    denyPermission: (error: Error) => {
      denial = error
    },
    denyWebfetch: (error: Error) => {
      webfetchDenial = error
    },
  }
}

// The text of an OpenCode 2 result: the content itself, or its text part when a file is attached.
export function v2Text(content: V2Content): string {
  if (typeof content === "string") return content
  const text = content.find((part) => part.type === "text")
  if (!text) throw new Error("the result has no text part")
  return text.text
}

export function v2ToolContext(signal: AbortSignal, sessionID = SESSION_ID) {
  return { sessionID, agent: "build", messageID: "msg_test", id: "call_test", signal, progress: async () => {} }
}

export async function loadV2Tool(options: V2Options = {}) {
  if (options.backend) selectBackendVariable(options.backend)
  const fake = createV2Context(options)
  await plugin.setup(fake.context)
  // With several backends a name repeats, so the namespace tells them apart.
  const toolNamed = (name: string, namespace?: string) => {
    const found = fake.registered.find(
      (candidate) => candidate.name === name && (namespace === undefined || candidate.options.namespace === namespace),
    )
    if (!found) throw new Error(`${name} is not registered`)
    return found
  }
  return {
    ...fake,
    // Every backend registers imagegen.
    tool: toolNamed("imagegen"),
    toolNamed,
    run: (rawArgs: unknown, signal = new AbortController().signal, sessionID?: string, name = "imagegen") =>
      toolNamed(name).execute(rawArgs, v2ToolContext(signal, sessionID)),
  }
}

export function v1ToolContext(directory: string, signal: AbortSignal, ask: ToolContext["ask"]): ToolContext {
  return { directory, abort: signal, ask } as unknown as ToolContext
}

export async function v1Harness(directory: string, flavour?: Flavour, toolName = "imagegen"): Promise<ToolHarness> {
  if (flavour) selectBackendVariable(flavour.backend)
  const hooks = await plugin.server({} as never)
  const tool = hooks.tool?.[toolName]
  if (!tool) throw new Error(`${toolName} is not registered`)
  const permissionRequests: Array<Parameters<ToolContext["ask"]>[0]> = []
  let denial: Error | undefined
  let webfetchDenial: Error | undefined
  const ask: ToolContext["ask"] = async (input) => {
    permissionRequests.push(input)
    if (input.permission === "webfetch" && webfetchDenial) throw webfetchDenial
    if (denial) throw denial
  }
  return {
    permissionRequests,
    webfetchUrls: () =>
      permissionRequests.filter((request) => request.permission === "webfetch").flatMap((request) => request.patterns),
    denyPermission: (error) => {
      denial = error
    },
    denyWebfetch: (error) => {
      webfetchDenial = error
    },
    async execute(rawArgs, signal = new AbortController().signal) {
      const result = (await tool.execute(rawArgs as never, v1ToolContext(directory, signal, ask))) as {
        output: string
        metadata?: { out: string; versioned: boolean }
      }
      return { message: result.output, out: result.metadata?.out, versioned: result.metadata?.versioned }
    },
  }
}

export async function v2Harness(directory: string, flavour?: Flavour, toolName = "imagegen"): Promise<ToolHarness> {
  const loaded = await loadV2Tool({ directory, backend: flavour?.backend })
  return {
    permissionRequests: loaded.calls.assert,
    webfetchUrls: () =>
      loaded.calls.assert
        .filter((request) => request.action === "webfetch")
        .flatMap((request) => request.resources as string[]),
    denyPermission: loaded.denyPermission,
    denyWebfetch: loaded.denyWebfetch,
    async execute(rawArgs, signal) {
      const result = await loaded.run(rawArgs, signal, undefined, toolName)
      return { message: v2Text(result.content), out: result.output?.out, versioned: result.output?.versioned }
    },
  }
}
