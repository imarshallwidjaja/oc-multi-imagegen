// The credential rules every host shares. Reading a credential is each host's own work (auth.ts on OpenCode 1, the
// host's integration store on OpenCode 2); this module reads no file and no variable's value.

import type { Plugin } from "@opencode/plugin"

export type OAuthCredential = { type: "oauth"; access: string; accountId?: string }
export type KeyCredential = { type: "key"; key: string }
// OpenCode 2's image generation and model catalog, which the "opencode" backend uses.
type GenerateImage = Plugin.Context["experimental"]["generate"]["image"]
export type HostGenerateImageInput = Parameters<GenerateImage>[0]
export type HostGenerateImageResult = Awaited<ReturnType<GenerateImage>>
export type HostImageModel = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
// The host's own connected providers stand in for a credential: the host signs the request itself. The signal is
// passed to the host, which stops the request when it aborts.
export type HostCredential = {
  type: "host"
  generateImage: (input: HostGenerateImageInput, signal: AbortSignal) => Promise<HostGenerateImageResult>
  listImageModels: (signal: AbortSignal) => Promise<readonly HostImageModel[]>
}
export type ImageCredential = OAuthCredential | KeyCredential | HostCredential

// Which OpenCode credential a backend consumes. `provider` is the id OpenCode stores it under, and `label` names it
// in messages. A key credential belongs to this plugin: each host adapter registers its sign-in method under
// `provider`, and `environmentVariable` names the variable of the OpenCode process that supplies the key ahead of the
// saved one. An oauth credential belongs to the host's own sign-in for that provider and has no variable. A host
// credential is OpenCode 2's model catalog and generation API, which use the host's provider connections.
export type CredentialSpec =
  | { type: "oauth"; provider: string; label: string }
  | { type: "key"; provider: string; label: string; environmentVariable: string }
  | { type: "host"; provider: string; label: string }

// The credential a backend's requests receive for its spec.
export type CredentialFor<C extends CredentialSpec> = Extract<ImageCredential, { type: C["type"] }>

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

// Header values cannot hold whitespace or control characters; fetch would otherwise reject the value in an error
// message that quotes it.
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/

// Checks a resolved credential against the backend's spec before anything else uses it: the kind must match, and a
// key must be usable in an HTTP header. The errors name the backend's label and never repeat the credential.
export function acceptCredential<C extends CredentialSpec>(spec: C, credential: ImageCredential): CredentialFor<C> {
  if (credential.type !== spec.type) {
    throw new Error(`The backend needs a ${spec.type} credential but received ${credential.type}.`)
  }
  if (credential.type === "key" && !HEADER_SAFE_KEY.test(credential.key)) {
    throw new Error(`The ${spec.label} key contains characters that cannot be sent in an HTTP header.`)
  }
  return credential as CredentialFor<C>
}
