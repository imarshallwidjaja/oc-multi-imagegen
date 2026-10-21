// The body is untrusted JSON, so `b64_json` is `unknown` until it is checked below.
type ImagesResponse = { data?: Array<{ b64_json?: unknown }> } | null

type ImagesRequest = {
  // Names the backend in error messages.
  label: string
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
  // Removed from an error body before it is reported.
  secret: string
}

// POSTs a JSON images request and returns the first image as base64. Every OpenAI-style images backend answers
// with `data[0].b64_json`. Nothing is retried.
export async function postImagesRequest(request: ImagesRequest): Promise<string> {
  const res = await fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...request.headers },
    body: JSON.stringify(request.body),
    signal: request.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const detail = request.secret ? body.replaceAll(request.secret, "[redacted]") : body
    throw new Error(`${request.label} images request failed: ${res.status} ${detail.slice(0, 500)}`)
  }
  const image = ((await res.json()) as ImagesResponse)?.data?.[0]?.b64_json
  // Only a non-empty string is base64 text: Buffer.from also accepts arrays and `{ type: "Buffer", data }` objects,
  // so a non-string field could otherwise reach the file as decoded bytes. An empty string would write a 0-byte file.
  if (typeof image !== "string" || image === "") {
    throw new Error(`no image returned by ${request.label} images endpoint`)
  }
  return image
}
