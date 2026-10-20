import type { Plugin } from "@opencode/plugin"
import { generateImage, IMAGEGEN_DESCRIPTION, IMAGEGEN_TOOL } from "./imagegen"
import { argsSchema, resultSchema } from "./schema"
import { loadPackagedSkill } from "./skill"
import type { OpenAIAuth } from "./types"

// The OpenAI integration methods whose OAuth credential the Codex images endpoint accepts.
const CHATGPT_METHOD_IDS = new Set(["chatgpt-browser", "chatgpt-headless"])
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing"
const SIGN_IN_HINT = "Sign in to the OpenAI integration with the Codex browser or Codex device code method."

// Resolved on every call so a refreshed or switched account takes effect without reloading the plugin.
// Resolution failures propagate unchanged, and no other credential source is consulted.
async function resolveChatGptAuth(integration: Plugin.Context["integration"]): Promise<OpenAIAuth> {
  const connection = await integration.connection.active("openai")
  if (!connection) {
    throw new Error(`No OpenAI connection is active. ${SIGN_IN_HINT}`)
  }
  const credential = await integration.connection.resolve(connection)
  if (!credential) {
    throw new Error(`The active OpenAI connection has no usable credential. ${SIGN_IN_HINT}`)
  }
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

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

// OpenCode 2 entry point. The tool is called directly (not through Code Mode, no namespace), so it is
// available to agents that allow imagegen without also allowing the execute tool.
export const setup: Plugin.Plugin["setup"] = async (ctx) => {
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
  await ctx.tool.transform((editor) => {
    editor.add({
      name: IMAGEGEN_TOOL,
      description: IMAGEGEN_DESCRIPTION,
      input: argsSchema,
      output: resultSchema,
      options: { codemode: false },
      async execute(input, context) {
        const saved = await generateImage(input, {
          signal: context.signal,
          authorize: (args) =>
            ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: IMAGEGEN_TOOL,
              resources: ["*"],
              save: ["*"],
              metadata: { ...args },
              source: { type: "tool", messageID: context.messageID, id: context.id },
            }),
          // A session can run in a different directory than the one that loaded the plugin.
          resolveDirectory: async () => (await ctx.session.get({ sessionID: context.sessionID })).location.directory,
          resolveAuth: () => resolveChatGptAuth(ctx.integration),
        })
        const result = { out: saved.savedPath, versioned: saved.versioned }
        return { output: result, content: saved.message, metadata: result }
      },
    })
  })
}
