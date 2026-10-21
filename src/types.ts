import type { z } from "zod"
import type { ArgsShape, GenerateArgs } from "./schema"

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

// What a backend's reference images must satisfy, checked when the files are read and before the request is sent.
export type ReferenceRules = { mimeTypes?: readonly string[]; maxDataUrlLength?: number }

// One image backend. The active backend is chosen by the OC_MULTI_IMAGEGEN_BACKEND variable when the plugin loads. A
// backend owns everything specific to its provider: the argument schema and defaults, the request, the limits and the
// credential.
export type Backend = {
  id: string
  credential: CredentialSpec
  // Sentences of the tool description that differ per backend; imagegen.ts assembles them with the shared guidance.
  description: { subject: string; requires: string; controls: string }
  argsSchema: z.ZodObject<ArgsShape>
  references: ReferenceRules
  // Returns the generated image as base64. The credential is one of the kind named by `credential`.
  generate: (
    credential: ImageCredential,
    args: GenerateArgs,
    referenceDataUrls: string[],
    signal: AbortSignal,
  ) => Promise<string>
  // Text appended to the result message for this call, for example to separate requested from verified settings.
  resultNote?: (args: GenerateArgs) => string | undefined
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
