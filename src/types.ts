// Minimal ChatGPT OAuth credential required by this plugin; each host adapter supplies it.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }
