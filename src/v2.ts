import * as path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { selectBackends } from "./backend"
import {
  type CredentialSpec,
  emptyEnvironmentError,
  environmentOverride,
  type HostCredential,
  type ImageCredential,
} from "./credential"
import { invokeTool } from "./invocation"
import { resultSchema } from "./schema"
import { loadPackagedSkill, SKILL_NAME } from "./skill"
import type { Backend, ProviderAccess } from "./types"

// The OpenAI integration methods whose OAuth credential the Codex images endpoint accepts.
const CHATGPT_METHOD_IDS = new Set(["chatgpt-browser", "chatgpt-headless"])
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing"
const SIGN_IN_HINT = "Sign in to the OpenAI integration with the Codex browser or Codex device code method."

type Integration = Plugin.Context["integration"]
// The credentials the integration store holds; a host credential is the host itself.
type StoredSpec = Exclude<CredentialSpec, { type: "host" }>

// The credential is resolved on every call so a refreshed or switched account takes effect without reloading the
// plugin. Resolution failures propagate unchanged, and no other credential source is consulted.
async function resolveActiveCredential(integration: Integration, spec: StoredSpec) {
  const name = spec.type === "oauth" ? "OpenAI" : spec.label
  const hint =
    spec.type === "oauth"
      ? SIGN_IN_HINT
      : `Set ${spec.environmentVariable} in the environment of the OpenCode process, or add an API key to the ${spec.provider} integration.`
  const connection = await integration.connection.active(spec.provider)
  if (!connection) {
    throw new Error(`No ${name} connection is active. ${hint}`)
  }
  const credential = await integration.connection.resolve(connection)
  if (!credential) {
    throw new Error(`The active ${name} connection has no usable credential. ${hint}`)
  }
  return credential
}

async function resolveChatGptAuth(integration: Integration, spec: StoredSpec): Promise<ImageCredential> {
  const credential = await resolveActiveCredential(integration, spec)
  if (credential.type !== "oauth") {
    throw new Error(
      `The active OpenAI connection is not a ChatGPT sign-in; an API key is not sufficient. ${SIGN_IN_HINT}`,
    )
  }
  if (credential.methodID === TOKEN_SHARING_METHOD_ID) {
    throw new Error(`ChatGPT token-sharing sign-in cannot call the Codex image backend. ${SIGN_IN_HINT}`)
  }
  if (!CHATGPT_METHOD_IDS.has(credential.methodID)) {
    throw new Error(`Unsupported OpenAI sign-in method "${credential.methodID}". ${SIGN_IN_HINT}`)
  }
  const accountId = credential.metadata?.accountID
  return {
    type: "oauth",
    access: credential.access,
    ...(typeof accountId === "string" ? { accountId } : {}),
  }
}

// The host lists a saved credential before an environment connection, so `active` would return the saved key even
// when the variable is set. A present variable is therefore resolved directly as an environment connection, which
// makes the host read the value; the plugin only checks that the variable exists. Without it, the saved key applies.
// A present but empty variable resolves to nothing and fails without consulting the saved key.
async function resolveApiKey(integration: Integration, spec: StoredSpec): Promise<ImageCredential> {
  const name = environmentOverride(spec)
  let credential: Awaited<ReturnType<Integration["connection"]["resolve"]>>
  if (name === undefined) {
    credential = await resolveActiveCredential(integration, spec)
  } else {
    credential = await integration.connection.resolve({ type: "env", name })
    if (!credential) throw emptyEnvironmentError(spec, name)
  }
  if (credential.type !== "key") {
    throw new Error(
      `The active ${spec.label} connection is not an API key. Add an API key to the ${spec.provider} integration.`,
    )
  }
  return { type: "key", key: credential.key }
}

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type ToolCallContext = Parameters<Parameters<ToolEditor["add"]>[0]["execute"]>[1]

const NAMESPACE = "image"

// The Code Mode namespace of a backend's tools: "image" when it is the only backend, otherwise "image.<backend>" with
// the id as a path segment ("openai-api" becomes tools.image.openai_api).
const namespaceOf = (backend: Backend, backends: readonly Backend[]) =>
  backends.length === 1 ? NAMESPACE : `${NAMESPACE}.${backend.id.replaceAll("-", "_")}`

function describeNamespace(backends: readonly Backend[]): string {
  const via =
    backends.length === 1
      ? `via ${backends[0].summary}`
      : `with one namespace per backend: ${backends.map((backend) => `${namespaceOf(backend, backends)} (${backend.summary})`).join("; ")}`
  return [
    `Generate and edit images ${via}.`,
    "Each call makes one image and saves it to a local file before returning, never overwriting (an existing name gets a -vN suffix), and reports its format, dimensions and alpha; run independent calls in parallel.",
    `Load the ${SKILL_NAME} skill first if available and permitted.`,
  ].join(" ")
}

// A backend with a host credential generates through the host's image generation and model catalog.
function assertHostImageApi(ctx: Plugin.Context, id: string): void {
  const partial = ctx as { experimental?: { generate?: { image?: unknown } }; model?: { list?: unknown } }
  if (typeof partial.experimental?.generate?.image !== "function" || typeof partial.model?.list !== "function") {
    throw new Error(
      `The "${id}" backend requires an OpenCode 2 host with ctx.experimental.generate.image and ctx.model.list.`,
    )
  }
}

// OpenCode 2 entry point. The backends come from the plugin options or OC_MULTI_IMAGEGEN_BACKEND (see selectBackends),
// read again whenever the host reloads the plugin. Tools are registered for Code Mode in a described namespace: one
// backend uses "image" (tools.image.imagegen), several use "image.<backend>" (tools.image.openai_api.imagegen). The
// permission action stays the bare tool name, so existing rules keep applying; the resource is the backend id. When an
// agent's permissions deny execute, OpenCode 2.3.2 and later expose the tools directly instead.
export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const backends = selectBackends(ctx.options)
  const hostBackend = backends.find((backend) => backend.credential.type === "host")
  if (hostBackend) assertHostImageApi(ctx, hostBackend.id)
  const skill = await loadPackagedSkill()
  // The host replays this callback on every skill reload, so it must not add a second copy, and an existing
  // skill with the same id is left alone.
  await ctx.skill.transform((editor: SkillEditor) => {
    if (editor.get(skill.name)) return
    // The host brands ids and absolute paths; the loader returns plain strings.
    editor.add({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      autoinvoke: true,
      path: skill.path,
      content: skill.content,
    } as Parameters<SkillEditor["add"]>[0])
  })
  // A key credential is an integration owned by this plugin, with a key method for saving one and an env method
  // for the variable that overrides it. The OpenAI integration is the host's.
  for (const { credential: spec } of backends) {
    if (spec.type !== "key") continue
    await ctx.integration.transform((editor) => {
      editor.update(spec.provider, (integration) => {
        integration.name = spec.label
      })
      editor.method.update({ integrationID: spec.provider, method: { type: "key" } })
      editor.method.update({ integrationID: spec.provider, method: { type: "env", names: [spec.environmentVariable] } })
    })
  }
  // The host signs the request with the model's provider connection and lists the models of its own catalog.
  const hostCredential: HostCredential = {
    type: "host",
    generateImage: (input, signal) => ctx.experimental.generate.image(input, { signal }),
    listImageModels: async (signal) => (await ctx.model.list({ types: ["image"] }, { signal })).data,
  }
  const resolveCredential = async (spec: CredentialSpec): Promise<ImageCredential> => {
    switch (spec.type) {
      case "oauth":
        return resolveChatGptAuth(ctx.integration, spec)
      case "key":
        return resolveApiKey(ctx.integration, spec)
      case "host":
        return hostCredential
    }
  }
  const providerAccess = (backend: Backend, context: ToolCallContext): ProviderAccess => ({
    signal: context.signal,
    // The action is the tool's name and the resource is the backend id, so a grant saved for one backend does not
    // cover another.
    authorize: (action, args) =>
      ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action,
        resources: [backend.id],
        save: [backend.id],
        metadata: args,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      }),
    resolveCredential: () => resolveCredential(backend.credential),
    // A reference URL is fetched under the host's webfetch permission; a saved grant covers the URL's origin. An
    // origin containing "*" would save a wildcard rule covering other hosts, so it saves nothing, as OpenCode's own
    // webfetch does.
    authorizeFetch: (url) => {
      const origin = new URL(url).origin
      return ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action: "webfetch",
        resources: [url],
        save: origin.includes("*") ? [] : [origin, `${origin}/*`],
        metadata: { url },
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
    },
  })
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: NAMESPACE, description: describeNamespace(backends) })
    for (const backend of backends) {
      const namespace = namespaceOf(backend, backends)
      if (backends.length > 1) editor.namespace({ name: namespace, description: backend.summary })
      for (const tool of backend.tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.schema,
          ...(tool.kind === "image" ? { output: resultSchema } : {}),
          options: { namespace, permission: tool.name, codemode: true },
          async execute(input, context) {
            const result = await invokeTool(tool, input, {
              providerAccess: () => providerAccess(backend, context),
              // A session can run in a different directory than the one that loaded the plugin.
              resolveDirectory: async () =>
                (await ctx.session.get({ sessionID: context.sessionID }, { signal: context.signal })).location
                  .directory,
            })
            if (!result.image) return { content: result.text }
            const output = { ...result.image, message: result.text }
            if (!result.preview) return { output, content: result.text, metadata: result.image }
            const { mime, bytes } = result.preview
            return {
              output,
              content: [
                { type: "text" as const, text: result.text },
                {
                  type: "file" as const,
                  uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                  mime,
                  name: path.basename(result.image.out),
                },
              ],
              metadata: result.image,
            }
          },
        })
      }
    }
  })
}
