import type { GenerateArgs } from "./schema"
import { appendSizeToPrompt } from "./size"
import type { OpenAIAuth } from "./types"

// Codex OAuth images endpoint URLs. Codex calls edits when reference images are given.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/model-provider-info/src/lib.rs#L80
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/codex-api/src/endpoint/images.rs#L62-L83
const CODEX_IMAGES_GENERATIONS_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
const CODEX_IMAGES_EDITS_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits"

// Same body as Codex. The backend appears to ignore model, quality, and size, and honors only background.
// https://github.com/openai/codex/blob/a4ebc509f4cdff88a8e58e175541970a30a2d385/codex-rs/ext/image-generation/src/tool.rs#L414-L440
const CODEX_REQUEST_DEFAULTS = { model: "gpt-image-2", quality: "auto", size: "auto" }

type CodexImagesResponse = { data?: Array<{ b64_json?: string }> }

export async function callViaCodexImages(
  auth: OpenAIAuth,
  args: GenerateArgs,
  inputImageDataUrls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const isEdit = inputImageDataUrls.length > 0
  const body = {
    prompt: appendSizeToPrompt(args.prompt, args.size),
    ...CODEX_REQUEST_DEFAULTS,
    background: args.background ?? "opaque",
    ...(isEdit ? { images: inputImageDataUrls.map((dataUrl) => ({ image_url: dataUrl })) } : {}),
  }

  const res = await fetch(isEdit ? CODEX_IMAGES_EDITS_ENDPOINT : CODEX_IMAGES_GENERATIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`codex images request failed: ${res.status} ${detail.slice(0, 500)}`)
  }
  const image = ((await res.json()) as CodexImagesResponse).data?.[0]?.b64_json
  // Reject an empty image too: decoding it would write a 0-byte file and report success.
  if (!image) {
    throw new Error("no image returned by codex images endpoint")
  }
  return image
}
