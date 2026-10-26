import { codexBackend } from "./codex"
import { nanoGptBackend } from "./nano-gpt"
import { openaiApiBackend } from "./openai-api"
import type { Backend } from "./types"

// Every backend the plugin can run. The OC_MULTI_IMAGEGEN_BACKEND variable selects one when the plugin loads, so each
// load exposes the arguments, defaults and limits of that backend only. Adding a backend means adding it here.
const BACKENDS: readonly Backend[] = [codexBackend, openaiApiBackend, nanoGptBackend]

const DEFAULT_BACKEND = codexBackend

// "codex, openai-api or nano-gpt"
function listIds(backends: readonly Backend[]): string {
  const ids = backends.map((backend) => backend.id)
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} or ${ids[ids.length - 1]}`
}

const BACKEND_VARIABLE = "OC_MULTI_IMAGEGEN_BACKEND"

// The plugin takes no options: its settings come from the environment of the OpenCode process. An option left over
// from the earlier `backend` setting fails the load with the variable to use instead of being ignored.
function rejectPluginOptions(options: unknown): void {
  if (options == null) return
  const names = typeof options === "object" && !Array.isArray(options) ? Object.keys(options) : ["(not an object)"]
  if (names.length === 0) return
  if (names.includes("backend")) {
    throw new Error(
      `The oc-multi-imagegen "backend" plugin option is no longer supported. Remove it from the plugin entry and set ${BACKEND_VARIABLE}=${BACKENDS.map((backend) => backend.id).join("|")} in the environment of the OpenCode process.`,
    )
  }
  throw new Error(
    `oc-multi-imagegen takes no plugin options (found ${names.join(", ")}). Remove them from the plugin entry; ${BACKEND_VARIABLE} selects the backend.`,
  )
}

// Returns the backend that OC_MULTI_IMAGEGEN_BACKEND selects. The variable is read once, when the plugin loads. An unset variable
// selects Codex; a variable that is set but empty or unknown fails the load instead of silently falling back, and
// the error does not repeat the value.
export function selectBackend(options: unknown): Backend {
  rejectPluginOptions(options)
  const value = process.env[BACKEND_VARIABLE]
  if (value === undefined) return DEFAULT_BACKEND
  const backend = BACKENDS.find((candidate) => candidate.id === value)
  if (!backend) {
    throw new Error(
      `${BACKEND_VARIABLE} is ${value === "" ? "empty" : "not a known backend"}. Use ${listIds(BACKENDS)}, or unset it to use ${DEFAULT_BACKEND.id}.`,
    )
  }
  return backend
}
