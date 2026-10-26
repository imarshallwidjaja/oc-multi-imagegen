import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import { CONTROL_NAMES } from "../../src/nano-gpt-models"
import type { resultSchema } from "../../src/schema"
import type { ToolSchema } from "../../src/types"

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
  // The provider failure message for an HTTP 500 answering "upstream boom".
  failure: string
  // The message for a provider answer that holds no usable image.
  unusableResponse: string
}

export type Flavour = {
  backend: Backend
  authorization: string
  // The permission resource the host is asked for.
  resource: string
  // The credential provider id it reads from the OpenCode credential store.
  provider: string
  // The tools the shared tests call.
  operations: Operation[]
  // The call that edits the given reference images in the shared flow, and the endpoint it posts to.
  editTool: string
  editArgs: (images: string[]) => Record<string, unknown>
  editsUrl: string
  // The reference data URLs of an editing request body, in order.
  editReferences: (body: Record<string, unknown>) => string[]
  // Whether an argument the tool does not define is dropped (true) or rejected (false).
  dropsUnknownArguments: boolean
  // For a key credential: the variable that overrides the saved key, and the saved key itself.
  key?: { variable: string; saved: string; label: string }
}

const legacyReferences = (body: Record<string, unknown>) =>
  (body.images as Array<{ image_url: string }> | undefined)?.map((image) => image.image_url) ?? []

// A size both Codex and the OpenAI Images API accept.
export const SHARED_SIZE = "1536x1024"
const LEGACY_ARGS = { prompt: "a cat", out: "cat.png", size: SHARED_SIZE }
const LEGACY_INVALID: Operation["invalid"] = [
  ["an unsupported background", { ...LEGACY_ARGS, background: "auto" }, "at background"],
  ["a missing prompt", { out: "cat.png", size: SHARED_SIZE }, "at prompt"],
  ["an empty model", { ...LEGACY_ARGS, model: "" }, "at model"],
  ["a non-string quality", { ...LEGACY_ARGS, quality: 3 }, "at quality"],
  ["a missing size", { prompt: "a cat", out: "cat.png" }, "Missing size"],
]

function legacyOperation(url: string, label: string): Operation {
  return {
    tool: "imagegen",
    url,
    args: LEGACY_ARGS,
    invalid: LEGACY_INVALID,
    nulls: { images: null, background: null, model: null, quality: null } as Record<string, null>,
    nullBody: { background: "opaque" },
    absentWhenNull: [],
    failure: `${label} images request failed: 500 upstream boom`,
    unusableResponse: `no image returned by ${label} images endpoint`,
  }
}

const NANO_URL = "https://api.nano-gpt.com/api/v1/images"
const NANO_ABSENT = [...CONTROL_NAMES]
const NANO_NULLS = Object.fromEntries(CONTROL_NAMES.map((name) => [name, null]))
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
    authorization: "Bearer tok",
    resource: "codex",
    provider: "openai",
    operations: [legacyOperation("https://chatgpt.com/backend-api/codex/images/generations", "codex")],
    editTool: "imagegen",
    editArgs: (images) => ({ ...LEGACY_ARGS, images }),
    editsUrl: "https://chatgpt.com/backend-api/codex/images/edits",
    editReferences: legacyReferences,
    dropsUnknownArguments: true,
  },
  {
    backend: "openai-api",
    authorization: "Bearer sk-images",
    resource: "openai-api",
    provider: "openai-images",
    operations: [legacyOperation("https://api.openai.com/v1/images/generations", "openai-api")],
    editTool: "imagegen",
    editArgs: (images) => ({ ...LEGACY_ARGS, images }),
    editsUrl: "https://api.openai.com/v1/images/edits",
    editReferences: legacyReferences,
    dropsUnknownArguments: true,
    key: { variable: "OC_MULTI_IMAGEGEN_OPENAI_API_KEY", saved: "sk-images", label: "OpenAI Images API" },
  },
  {
    backend: "nano-gpt",
    authorization: "Bearer sk-nano",
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
        failure: "NanoGPT imagegen (nano-banana-pro) request failed: HTTP 500: upstream boom.",
        unusableResponse: NANO_UNUSABLE,
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
        failure: "NanoGPT imageedit (nano-banana-pro-edit) request failed: HTTP 500: upstream boom.",
        unusableResponse: NANO_UNUSABLE,
      },
    ],
    editTool: "imageedit",
    editArgs: (images) => ({ ...NANO_EDIT_ARGS, images }),
    editsUrl: NANO_URL,
    editReferences: nanoReferences,
    dropsUnknownArguments: false,
    key: { variable: "OC_MULTI_IMAGEGEN_NANOGPT_API_KEY", saved: "sk-nano", label: "NanoGPT API" },
  },
]

// Selects the backend the way a deployment does, through the environment of the process that loads the plugin.
// Codex is the default, so it is the variable's absence.
export function selectBackendVariable(backend: Backend | undefined): void {
  if (backend === undefined || backend === "codex") delete process.env.OC_MULTI_IMAGEGEN_BACKEND
  else process.env.OC_MULTI_IMAGEGEN_BACKEND = backend
}

// The image API key as the environment variable carries it, distinct from the saved key in STORED_CREDENTIALS and
// IMAGES_KEY_CREDENTIAL so a test can tell which source a request used.
export const ENVIRONMENT_KEY = "sk-from-environment"

// OpenCode 1's stored credentials for every backend: the chat provider's ChatGPT sign-in and the image keys.
export const STORED_CREDENTIALS = {
  openai: { type: "oauth", access: "tok", refresh: "refresh", expires: 4102444800000 },
  "openai-images": { type: "api", key: "sk-images" },
  "nano-gpt-images": { type: "api", key: "sk-nano" },
}

// An information tool saves nothing, so `out` and `versioned` are absent for it.
export type NormalizedResult = { message: string; out?: string; versioned?: boolean }

export type ToolHarness = {
  // Every permission request the adapter made, in the host's own request shape.
  permissionRequests: unknown[]
  // Makes the next permission requests fail as a host denial would.
  denyPermission: (error: Error) => void
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
    output: { out: string; versioned: boolean }
    content: string
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
  backend?: Backend
  // Plugin options as the host passes them. The plugin takes none.
  pluginOptions?: Record<string, unknown>
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
  access: "tok",
  expires: Number.MAX_SAFE_INTEGER,
}

export const IMAGES_KEY_CREDENTIAL = { type: "key", key: "sk-images" }
export const NANO_KEY_CREDENTIAL = { type: "key", key: "sk-nano" }

export function createV2Context(options: V2Options = {}) {
  const calls = {
    assert: [] as Array<Record<string, unknown>>,
    sessionGet: [] as Array<{ sessionID: string }>,
    active: [] as string[],
    resolve: [] as unknown[],
  }
  // Like the host, each integration has its own connection and credential; an unknown integration has none.
  const store: Record<string, { connection?: unknown; credential?: unknown }> = {
    openai: {
      connection: "connection" in options ? options.connection : { type: "credential", id: "cred_1", method: "oauth" },
      credential: "credential" in options ? options.credential : CHATGPT_BROWSER_CREDENTIAL,
    },
    "openai-images": {
      connection: { type: "credential", id: "cred_2", method: "key" },
      credential: IMAGES_KEY_CREDENTIAL,
    },
    "nano-gpt-images": {
      connection: { type: "credential", id: "cred_3", method: "key" },
      credential: NANO_KEY_CREDENTIAL,
    },
    ...options.integrations,
  }
  const integrations = new Map<string, { name: string }>()
  const integrationMethods: Array<{ integrationID: string; method: { type: string; names?: string[] } }> = []
  const registered: RegisteredTool[] = []
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
  const context = {
    // A directory the adapter must not use: sessions carry their own location.
    location: { directory: "/plugin-load-directory" },
    options: options.pluginOptions ?? {},
    tool: {
      transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        callback({ add: (tool) => registered.push(tool) })
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
    permission: {
      assert: async (input: Record<string, unknown>) => {
        calls.assert.push(input)
        if (denial) throw denial
      },
    },
    session: {
      get: async (input: { sessionID: string }) => {
        calls.sessionGet.push(input)
        return { location: { directory: options.sessionDirectories?.[input.sessionID] ?? options.directory } }
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
  }
}

export function v2ToolContext(signal: AbortSignal, sessionID = SESSION_ID) {
  return { sessionID, agent: "build", messageID: "msg_test", id: "call_test", signal, progress: async () => {} }
}

export async function loadV2Tool(options: V2Options = {}) {
  if (options.backend) selectBackendVariable(options.backend)
  const fake = createV2Context(options)
  await plugin.setup(fake.context)
  const tool = fake.registered[0]
  const toolNamed = (name: string) => {
    const found = fake.registered.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`${name} is not registered`)
    return found
  }
  return {
    ...fake,
    tool,
    toolNamed,
    run: (rawArgs: unknown, signal = new AbortController().signal, sessionID?: string, name = tool.name) =>
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
  const permissionRequests: unknown[] = []
  let denial: Error | undefined
  const ask: ToolContext["ask"] = async (input) => {
    permissionRequests.push(input)
    if (denial) throw denial
  }
  return {
    permissionRequests,
    denyPermission: (error) => {
      denial = error
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
    denyPermission: loaded.denyPermission,
    async execute(rawArgs, signal) {
      const result = await loaded.run(rawArgs, signal, undefined, toolName)
      return { message: result.content, out: result.output?.out, versioned: result.output?.versioned }
    },
  }
}
