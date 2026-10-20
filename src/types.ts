import type { ImageSize } from "./size"

// Minimal subset of OpenCode auth.json's openai OAuth entry required by this plugin.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

export type GenerateArgs = {
  prompt: string
  out: string
  size: ImageSize
  images?: string[] | null
  background?: "opaque" | "transparent" | null
}
