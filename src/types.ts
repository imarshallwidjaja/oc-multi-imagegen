import type { z } from "zod"

// The credential kinds an image backend can use. Each host adapter reads them from OpenCode's own credential store.
export type OAuthCredential = { type: "oauth"; access: string; accountId?: string }
export type KeyCredential = { type: "key"; key: string }
export type ImageCredential = OAuthCredential | KeyCredential

// Which OpenCode credential a backend consumes. `provider` is the id OpenCode stores it under, and `label` names it
// in messages. A key credential belongs to this plugin: each host adapter registers its sign-in method under
// `provider`, and `environmentVariable` names the variable of the OpenCode process that supplies the key ahead of the
// saved one. An oauth credential belongs to the host's own sign-in for that provider and has no variable.
export type CredentialSpec =
  | { type: "oauth"; provider: string; label: string }
  | { type: "key"; provider: string; label: string; environmentVariable: string }

// Whether the process environment holds the variable that overrides the saved credential, by presence alone: the
// value is not read here, and a present but empty variable still counts, so it never falls back to the saved key.
export function environmentOverride(spec: CredentialSpec): string | undefined {
  return spec.type === "key" && Object.hasOwn(process.env, spec.environmentVariable)
    ? spec.environmentVariable
    : undefined
}

export function emptyEnvironmentError(spec: CredentialSpec, name: string): Error {
  return new Error(
    `${name} is set but empty. Set it to a key for the ${spec.label}, or unset it to use the key saved in OpenCode.`,
  )
}

// What a tool's reference images must satisfy, checked when the files are read and before the request is sent.
// `maxBytes` bounds the file itself; `maxDataUrlLength` bounds its base64 data URL.
export type ReferenceRules = { mimeTypes?: readonly string[]; maxDataUrlLength?: number; maxBytes?: number }

// The complete input schema of a tool. Tools validate with the whole schema, refinements included. OpenCode 1
// registers its `shape` and OpenCode 2 the schema itself. Strict and stripping objects are both accepted.
export type ToolSchema = z.ZodObject<z.core.$ZodLooseShape, z.core.$ZodObjectConfig>

// What a host adapter supplies for one image call. The flow in `defineImageTool` invokes these in order:
// authorize, resolveDirectory, resolveCredential.
export type ImageToolHost = {
  signal: AbortSignal
  // Asks the host to allow the whole operation of the tool named `action`. Rejects when the host denies it.
  authorize: (action: string, args: Record<string, unknown>) => Promise<void>
  resolveDirectory: () => Promise<string>
  // Returns the credential kind the active backend declares.
  resolveCredential: () => Promise<ImageCredential>
}

export type SavedImage = { savedPath: string; versioned: boolean; message: string }

// A tool that calls the provider, and saves one PNG. `run` parses the raw arguments with `schema` itself, because
// hosts can call execute without validating them first.
export type ImageTool = {
  kind: "image"
  name: string
  description: string
  schema: ToolSchema
  run: (rawArgs: unknown, host: ImageToolHost) => Promise<SavedImage>
}

// A tool that answers from data in this package. It needs no permission, credential, file or provider access.
export type InfoTool = {
  kind: "info"
  name: string
  description: string
  schema: ToolSchema
  run: (rawArgs: unknown) => string
}

export type BackendTool = ImageTool | InfoTool

// One image backend. The active backend is chosen by the OC_MULTI_IMAGEGEN_BACKEND variable when the plugin loads.
// A backend owns everything specific to its provider: the tools it registers (each with its own input schema,
// description and operation), the requests, the limits and the credential. Both host adapters register exactly
// these tools.
export type Backend = {
  id: string
  credential: CredentialSpec
  tools: readonly BackendTool[]
}

// Backends receive the credential kind they declared; a different kind means an adapter ignored `credential`.
export function expectCredential<T extends ImageCredential["type"]>(
  credential: ImageCredential,
  type: T,
): Extract<ImageCredential, { type: T }> {
  if (credential.type !== type)
    throw new Error(`The backend needs a ${type} credential but received ${credential.type}.`)
  return credential as Extract<ImageCredential, { type: T }>
}

// Header values cannot hold whitespace or control characters; fetch would otherwise reject the value in an error
// message that quotes it.
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/

// The key of a key credential, checked to be usable in an HTTP header. The error names the backend's label and
// never repeats the key.
export function expectHeaderSafeKey(credential: ImageCredential, label: string): string {
  const { key } = expectCredential(credential, "key")
  if (!HEADER_SAFE_KEY.test(key)) {
    throw new Error(`The ${label} key contains characters that cannot be sent in an HTTP header.`)
  }
  return key
}
