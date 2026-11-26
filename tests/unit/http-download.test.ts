import { describe, expect, test } from "bun:test"
import { readBoundedResponseBody, safeUrlLabel, validateHttpsUrl } from "../../src/http-download"

// NanoGPT's messages for these refusals are covered through the backend in nano-gpt.test.ts. These cases cover the
// helpers' own contract, which other callers rely on without NanoGPT's wording.

const stream = (chunks: Uint8Array[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel: onCancel,
  })

describe("validateHttpsUrl", () => {
  test("accepts an https URL with a host name and returns it parsed", () => {
    const result = validateHttpsUrl("https://cdn.example/a/b.png?sig=1")
    expect(result.ok && result.url.href).toBe("https://cdn.example/a/b.png?sig=1")
  })

  test.each([
    ["octal", "https://0177.0.0.1/x"],
    ["single integer", "https://2130706433/x"],
  ])("refuses an IPv4 host written in %s form", (_name, raw) => {
    expect(validateHttpsUrl(raw)).toEqual({ ok: false, reason: "its host is an IP address or localhost." })
  })
})

describe("safeUrlLabel", () => {
  test("keeps the origin and path and drops the query and fragment", () => {
    const label = safeUrlLabel(new URL("https://user.example:8443/a/b.png?X-Amz-Signature=SECRET#frag"))
    expect(label).toBe("https://user.example:8443/a/b.png")
  })
})

describe("readBoundedResponseBody", () => {
  test("returns every byte of a body within the limit", async () => {
    const result = await readBoundedResponseBody(new Response(stream([new Uint8Array([1, 2]), new Uint8Array([3])])), 3)
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) })
  })

  test("refuses a declared length above the limit without reading the body", async () => {
    const res = new Response(new Uint8Array(11), { headers: { "content-length": "11" } })
    const result = await readBoundedResponseBody(res, 10)
    expect(result).toEqual({ ok: false, refusal: { kind: "declared-too-large", declared: 11 } })
    expect(res.bodyUsed).toBe(false)
  })

  test("cancels a body that grows past the limit", async () => {
    let cancelled = false
    const result = await readBoundedResponseBody(
      new Response(
        stream([new Uint8Array(6), new Uint8Array(6)], () => {
          cancelled = true
        }),
      ),
      10,
    )
    expect(result).toEqual({ ok: false, refusal: { kind: "too-large" } })
    expect(cancelled).toBe(true)
  })

  test("refuses an empty body", async () => {
    expect(await readBoundedResponseBody(new Response(null), 10)).toEqual({ ok: false, refusal: { kind: "empty" } })
  })

  test("reports the received and declared lengths of an uncompressed mismatch", async () => {
    const result = await readBoundedResponseBody(
      new Response(new Uint8Array(4), { headers: { "content-length": "5" } }),
      10,
    )
    expect(result).toEqual({ ok: false, refusal: { kind: "length-mismatch", received: 4, declared: 5 } })
  })

  test("throws a failed read as the runtime raised it, for the caller to report", async () => {
    const failure = new Error("socket reset")
    const body = new ReadableStream({
      pull() {
        throw failure
      },
    })
    await expect(readBoundedResponseBody(new Response(body), 10)).rejects.toBe(failure)
  })
})
