import { codexBackend } from "./codex"
import { nanoGptBackend } from "./nano-gpt"
import { openaiApiBackend } from "./openai-api"
import { opencodeBackend } from "./opencode"
import type { Backend } from "./types"

// Every backend the plugin can run. OpenCode 1 runs one, selected by the OC_MULTI_IMAGEGEN_BACKEND variable; OpenCode 2
// runs one or more, selected by its plugin options or that variable. Each load exposes the arguments, defaults and
// limits of the selected backends only. Adding a backend means adding it here.
const BACKENDS: readonly Backend[] = [codexBackend, openaiApiBackend, nanoGptBackend, opencodeBackend]

// The opencode backend generates through OpenCode 2's own API, which OpenCode 1 does not have.
const V1_BACKENDS = BACKENDS.filter((backend) => backend !== opencodeBackend)

const DEFAULT_BACKEND = codexBackend

// "codex, openai-api or nano-gpt"
function listIds(backends: readonly Backend[]): string {
  const ids = backends.map((backend) => backend.id)
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} or ${ids[ids.length - 1]}`
}

const BACKEND_VARIABLE = "OC_MULTI_IMAGEGEN_BACKEND"
const OPENCODE_2_ONLY = `The "${opencodeBackend.id}" backend requires OpenCode 2; OpenCode 1 cannot run it.`

const findBackend = (id: unknown) => BACKENDS.find((candidate) => candidate.id === id)

// Read once, when the plugin loads. The error never repeats the variable's value.
function backendFromVariable(known: readonly Backend[]): Backend {
  const value = process.env[BACKEND_VARIABLE]
  if (value === undefined) return DEFAULT_BACKEND
  const backend = known.find((candidate) => candidate.id === value)
  if (!backend) {
    throw new Error(
      `${BACKEND_VARIABLE} is ${value === "" ? "empty" : "not a known backend"}. Use ${listIds(known)}, or unset it to use ${DEFAULT_BACKEND.id}.`,
    )
  }
  return backend
}

// OpenCode 1 takes no options: its settings come from the environment of the OpenCode process. An option left over
// from the earlier `backend` setting fails the load with the variable to use instead of being ignored.
function rejectPluginOptions(options: unknown): void {
  if (options == null) return
  const names = typeof options === "object" && !Array.isArray(options) ? Object.keys(options) : ["(not an object)"]
  if (names.length === 0) return
  if (names.includes("backend")) {
    throw new Error(
      `The oc-multi-imagegen "backend" plugin option is no longer supported. Remove it from the plugin entry and set ${BACKEND_VARIABLE}=${V1_BACKENDS.map((backend) => backend.id).join("|")} in the environment of the OpenCode process.`,
    )
  }
  throw new Error(
    `oc-multi-imagegen takes no plugin options (found ${names.join(", ")}). Remove them from the plugin entry; ${BACKEND_VARIABLE} selects the backend.`,
  )
}

// The one backend of an OpenCode 1 load.
export function selectBackend(options: unknown): Backend {
  rejectPluginOptions(options)
  if (process.env[BACKEND_VARIABLE] === opencodeBackend.id) throw new Error(OPENCODE_2_ONLY)
  return backendFromVariable(V1_BACKENDS)
}

const OPTION_KEYS = ["backend", "backends"]

// Validates OpenCode 2's plugin options. Errors name option keys and positions, never a value the operator wrote,
// so a secret placed in the wrong field does not reach a log.
function backendsFromOptions(options: unknown): Backend[] | undefined {
  if (options == null) return undefined
  const usage = `Use "backend": "<id>" or "backends": ["<id>", ...] with ${listIds(BACKENDS)}.`
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`oc-multi-imagegen plugin options must be an object. ${usage}`)
  }
  const record = options as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !OPTION_KEYS.includes(key))
  if (unknown.length) {
    throw new Error(`oc-multi-imagegen does not take the plugin option ${unknown.join(", ")}. ${usage}`)
  }
  const { backend, backends } = record
  if (backend !== undefined && backends !== undefined) {
    throw new Error(`oc-multi-imagegen takes "backend" or "backends", not both. ${usage}`)
  }
  if (backend !== undefined) {
    const found = findBackend(backend)
    if (!found) {
      const reason = typeof backend !== "string" ? "not a string" : backend === "" ? "empty" : "not a known backend"
      throw new Error(`The oc-multi-imagegen "backend" option is ${reason}. ${usage}`)
    }
    return [found]
  }
  if (backends === undefined) return undefined
  if (!Array.isArray(backends) || backends.length === 0) {
    throw new Error(`The oc-multi-imagegen "backends" option must be a non-empty list. ${usage}`)
  }
  const selected: Backend[] = []
  for (const [index, id] of backends.entries()) {
    const found = findBackend(id)
    if (!found) throw new Error(`backends[${index}] in the oc-multi-imagegen options is not a known backend. ${usage}`)
    if (selected.includes(found)) {
      throw new Error(`The oc-multi-imagegen "backends" option lists ${found.id} more than once.`)
    }
    selected.push(found)
  }
  return selected
}

// The backends of an OpenCode 2 load, in order. Options and the variable are exclusive: when both select, the load
// fails, so neither is silently ignored and a project's plugin options cannot override a deployment's variable.
export function selectBackends(options: unknown): Backend[] {
  const fromOptions = backendsFromOptions(options)
  if (fromOptions && Object.hasOwn(process.env, BACKEND_VARIABLE)) {
    throw new Error(
      `oc-multi-imagegen is configured twice: ${BACKEND_VARIABLE} is set and the plugin options select backends. Configure one or the other.`,
    )
  }
  return fromOptions ?? [backendFromVariable(BACKENDS)]
}
