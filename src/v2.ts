import type { Plugin } from "@opencode/plugin"
import { selectBackend } from "./backend"
import { describeImagegen, generateImage, IMAGEGEN_TOOL } from "./imagegen"
import { resultSchema } from "./schema"
import { loadPackagedSkill } from "./skill"
import { type CredentialSpec, emptyEnvironmentError, environmentOverride, type ImageCredential } from "./types"

// The OpenAI integration methods whose OAuth credential the Codex images endpoint accepts.
const CHATGPT_METHOD_IDS = new Set(["chatgpt-browser", "chatgpt-headless"])
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing"
const SIGN_IN_HINT = "Sign in to the OpenAI integration with the Codex browser or Codex device code method."

type Integration = Plugin.Context["integration"]

// The credential is resolved on every call so a refreshed or switched account takes effect without reloading the
// plugin. Resolution failures propagate unchanged, and no other credential source is consulted.
async function resolveActiveCredential(integration: Integration, spec: CredentialSpec) {
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

async function resolveChatGptAuth(integration: Integration, spec: CredentialSpec): Promise<ImageCredential> {
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
async function resolveApiKey(integration: Integration, spec: CredentialSpec): Promise<ImageCredential> {
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

// OpenCode 2 entry point. The tool is called directly (not through Code Mode, no namespace), so it is
// available to agents that allow imagegen without also allowing the execute tool.
export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const backend = selectBackend(ctx.options)
  const { credential: spec } = backend
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
  if (spec.type === "key") {
    await ctx.integration.transform((editor) => {
      editor.update(spec.provider, (integration) => {
        integration.name = spec.label
      })
      editor.method.update({ integrationID: spec.provider, method: { type: "key" } })
      editor.method.update({ integrationID: spec.provider, method: { type: "env", names: [spec.environmentVariable] } })
    })
  }
  await ctx.tool.transform((editor) => {
    editor.add({
      name: IMAGEGEN_TOOL,
      description: describeImagegen(backend),
      input: backend.argsSchema,
      output: resultSchema,
      options: { codemode: false },
      async execute(input, context) {
        const saved = await generateImage(input, backend, {
          signal: context.signal,
          // The resource is the backend id, so a grant saved for one backend does not cover another.
          authorize: (args) =>
            ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: IMAGEGEN_TOOL,
              resources: [backend.id],
              save: [backend.id],
              metadata: { ...args },
              source: { type: "tool", messageID: context.messageID, id: context.id },
            }),
          // A session can run in a different directory than the one that loaded the plugin.
          resolveDirectory: async () => (await ctx.session.get({ sessionID: context.sessionID })).location.directory,
          resolveCredential: () =>
            spec.type === "oauth" ? resolveChatGptAuth(ctx.integration, spec) : resolveApiKey(ctx.integration, spec),
        })
        const result = { out: saved.savedPath, versioned: saved.versioned }
        return { output: result, content: saved.message, metadata: result }
      },
    })
  })
}
