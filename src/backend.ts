import { z } from "zod"
import { codexBackend } from "./codex"
import { openaiApiBackend } from "./openai-api"
import type { Backend } from "./types"

// Every backend the plugin can run. The `backend` plugin option selects one when the plugin loads, so each load
// exposes the arguments, defaults and limits of that backend only. Adding a backend means adding it here.
const BACKENDS: readonly Backend[] = [codexBackend, openaiApiBackend]

const DEFAULT_BACKEND = codexBackend

const optionsSchema = z
  .object({
    backend: z.enum(BACKENDS.map((backend) => backend.id) as [string, ...string[]]).optional(),
  })
  .strict()

// Reads the plugin options both hosts hand to the plugin and returns the backend they select. An absent option
// selects Codex; an unknown option fails the load instead of silently falling back.
export function selectBackend(options: unknown): Backend {
  const parsed = optionsSchema.safeParse(options ?? {})
  if (!parsed.success) {
    throw new Error(`Invalid oc-multi-imagegen options. ${z.prettifyError(parsed.error)}`)
  }
  return BACKENDS.find((backend) => backend.id === parsed.data.backend) ?? DEFAULT_BACKEND
}
