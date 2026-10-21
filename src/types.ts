import type { z } from "zod"
import type { ArgsShape, GenerateArgs } from "./schema"

// The credential kinds an image backend can use. Each host adapter reads them from OpenCode's own credential store.
export type OAuthCredential = { type: "oauth"; access: string; accountId?: string }
export type KeyCredential = { type: "key"; key: string }
export type ImageCredential = OAuthCredential | KeyCredential

// Which OpenCode credential a backend consumes. `provider` is the id OpenCode stores it under, and `label` names it
// in messages. A key credential belongs to this plugin: each host adapter registers its sign-in method under
// `provider`. An oauth credential belongs to the host's own sign-in for that provider.
export type CredentialSpec = { type: ImageCredential["type"]; provider: string; label: string }

// What a backend's reference images must satisfy, checked when the files are read and before the request is sent.
export type ReferenceRules = { mimeTypes?: readonly string[]; maxDataUrlLength?: number }

// One image backend. The active backend is chosen by the plugin option `backend` when the plugin loads. A backend owns
// everything specific to its provider: the argument schema and defaults, the request, the limits and the credential.
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
