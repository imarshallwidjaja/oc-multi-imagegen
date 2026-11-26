// Primitives for downloading from a URL that an untrusted party supplied. Callers own the request, the redirect
// policy, the limit and every message: the reasons here name no URL or host, so a caller can show them as they are.

export type HttpsUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

// Accepts only https URLs without credentials whose host is a name. IP addresses and localhost are refused, with or
// without the trailing dots of a fully qualified name. WHATWG parsing already rewrites shortened, octal and hex IPv4
// forms as dotted decimal, so one pattern covers them. Whether a public name resolves to a private address is not
// checked.
export function validateHttpsUrl(raw: string): HttpsUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "it is not a valid URL." }
  }
  if (url.protocol !== "https:") return { ok: false, reason: "it is not an https URL." }
  if (url.username || url.password) return { ok: false, reason: "it contains credentials." }
  const host = url.hostname.replace(/\.+$/, "")
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("[") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  ) {
    return { ok: false, reason: "its host is an IP address or localhost." }
  }
  return { ok: true, url }
}

// A URL as it may appear in a message: the query and fragment, where signed URLs carry their tokens, are dropped.
export const safeUrlLabel = (url: URL): string => `${url.origin}${url.pathname}`

export type BodyRefusal =
  | { kind: "empty" }
  | { kind: "declared-too-large"; declared: number }
  | { kind: "too-large" }
  | { kind: "length-mismatch"; received: number; declared: number }

export type BoundedBody = { ok: true; bytes: Uint8Array } | { ok: false; refusal: BodyRefusal }

// Reads a response body of at most maxBytes. A declared length above the limit is refused before reading, a body that
// grows past it is cancelled, and an uncompressed body must match its declared length. A refusal is returned; a
// failure of the read itself, including cancellation through the request's signal, is thrown as the runtime raised it,
// so the caller decides what of it to report.
export async function readBoundedResponseBody(res: Response, maxBytes: number): Promise<BoundedBody> {
  const declaredText = res.headers.get("content-length")?.trim()
  const declared = declaredText && /^\d+$/.test(declaredText) ? Number(declaredText) : undefined
  if (declared !== undefined && declared > maxBytes)
    return { ok: false, refusal: { kind: "declared-too-large", declared } }
  // A compressed representation declares its encoded length while the body read here is decoded, so only an
  // uncompressed body can be held to it.
  const encoding = res.headers.get("content-encoding")?.trim().toLowerCase()
  const exactLength = !encoding || encoding === "identity" ? declared : undefined
  const chunks: Uint8Array[] = []
  let received = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > maxBytes) {
        // Releasing the body is best effort: a failure here must not replace the size refusal.
        await reader.cancel().catch(() => {})
        return { ok: false, refusal: { kind: "too-large" } }
      }
      chunks.push(value)
    }
  }
  if (received === 0) return { ok: false, refusal: { kind: "empty" } }
  if (exactLength !== undefined && received !== exactLength) {
    return { ok: false, refusal: { kind: "length-mismatch", received, declared: exactLength } }
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}
