import type { z } from "zod"
import type { CredentialSpec, ImageCredential } from "./credential"

// What a tool's reference images must satisfy, checked when the files are read and before the request is sent.
// `maxBytes` bounds the file itself; `maxDataUrlLength` bounds its base64 data URL.
export type ReferenceRules = { mimeTypes?: readonly string[]; maxDataUrlLength?: number; maxBytes?: number }

// The complete input schema of a tool. Tools validate with the whole schema, refinements included. OpenCode 1
// registers its `shape` and OpenCode 2 the schema itself. Strict and stripping objects are both accepted.
export type ToolSchema = z.ZodObject<z.core.$ZodLooseShape, z.core.$ZodObjectConfig>

// What a host adapter supplies for a call that reaches the provider. The shared flows invoke these in order:
// authorize, then resolveCredential (an image call resolves its directory between the two).
export type ProviderAccess = {
  signal: AbortSignal
  // Asks the host to allow the whole operation of the tool named `action`. Rejects when the host denies it.
  authorize: (action: string, args: Record<string, unknown>) => Promise<void>
  // Returns the credential the active backend declares. The shared flows check it before using it.
  resolveCredential: () => Promise<ImageCredential>
}

// What a host adapter supplies for one image call: provider access and the session directory that relative paths
// resolve against.
export type ImageToolHost = ProviderAccess & { resolveDirectory: () => Promise<string> }

export type SavedImage = { savedPath: string; versioned: boolean; message: string }

// A tool that calls the provider and saves one native image file in one of the formats it declares. `run` parses the
// raw arguments with `schema` itself, because hosts can call execute without validating them first.
export type ImageTool = {
  kind: "image"
  name: string
  description: string
  schema: ToolSchema
  run: (rawArgs: unknown, host: ImageToolHost) => Promise<SavedImage>
}

// A tool that asks the provider for information with the backend's credential, after the host allows it. It reads
// and writes no files, needs no session directory and returns text.
export type LookupTool = {
  kind: "lookup"
  name: string
  description: string
  schema: ToolSchema
  run: (rawArgs: unknown, host: ProviderAccess) => Promise<string>
}

// A tool that answers from data in this package. It needs no permission, credential, file or provider access.
export type InfoTool = {
  kind: "info"
  name: string
  description: string
  schema: ToolSchema
  run: (rawArgs: unknown) => string
}

export type BackendTool = ImageTool | LookupTool | InfoTool

// One image backend. OpenCode 1 runs the one OC_MULTI_IMAGEGEN_BACKEND selects; OpenCode 2 can run several, chosen
// by its plugin options or that variable when the plugin loads. A backend owns everything specific to its provider:
// the tools it registers (each with its own input schema, description and operation), the requests, the limits and
// the credential. Both host adapters register exactly these tools.
export type Backend = {
  id: string
  // One clause naming the provider and what sets it apart, for OpenCode 2's Code Mode namespace descriptions.
  summary: string
  credential: CredentialSpec
  tools: readonly BackendTool[]
}
