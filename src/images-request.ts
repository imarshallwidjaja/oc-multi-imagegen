type ImagesRequest = {
  // Names the backend in error messages.
  label: string
  url: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
  // Removed from an error body before it is reported.
  secret: string
}

const MAX_ERROR_DETAIL = 500

// POSTs a JSON images request and returns the first image's bytes. Every OpenAI-style images backend answers with
// base64 in `data[0].b64_json`, which is decoded here once it is known to be text. Nothing is retried.
export async function postImagesRequest(request: ImagesRequest): Promise<Uint8Array> {
  const res = await fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...request.headers },
    body: JSON.stringify(request.body),
    signal: request.signal,
  })
  if (!res.ok) {
    // An unreadable error body is reported without detail, unless the call was cancelled while it was read.
    const body = await res.text().catch(() => {
      request.signal.throwIfAborted()
      return ""
    })
    const detail = request.secret ? body.replaceAll(request.secret, "[redacted]") : body
    throw new Error(`${request.label} images request failed: ${res.status} ${detail.slice(0, MAX_ERROR_DETAIL)}`)
  }
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The parser's message quotes the body, so only the fact is reported.
    throw new Error(`${request.label} images endpoint returned a response that is not JSON; nothing was saved`)
  }
  const image = (parsed as { data?: Array<{ b64_json?: unknown }> } | null)?.data?.[0]?.b64_json
  // Only a non-empty string is base64 text: Buffer.from also accepts arrays and `{ type: "Buffer", data }` objects,
  // so a non-string field could otherwise reach the file as decoded bytes.
  if (typeof image !== "string" || image === "") {
    throw new Error(`no image returned by ${request.label} images endpoint`)
  }
  return Buffer.from(image, "base64")
}
