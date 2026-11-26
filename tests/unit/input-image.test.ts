import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type ReferenceSource, readReferenceImages } from "../../src/input-image"
import { pngDataUrl as dataUrl, PNG_BUFFER as PNG } from "./fixtures"

let dir: string
const originalFetch = globalThis.fetch

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "input-image-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

// A source that reads from `directory` and records every URL it is asked to allow, in order, with the fetches.
function sourceFor(directory: string, signal = new AbortController().signal) {
  const events: string[] = []
  let denial: Error | undefined
  const source: ReferenceSource = {
    directory,
    signal,
    authorizeFetch: async (url) => {
      events.push(`authorize ${url}`)
      if (denial) throw denial
    },
  }
  return {
    source,
    events,
    deny: (error: Error) => {
      denial = error
    },
  }
}

const read = async (entries: string[], directory = dir) =>
  (await readReferenceImages(entries, sourceFor(directory).source)).references

describe("readReferenceImages from local paths", () => {
  test("returns an empty array when given an empty list", async () => {
    expect(await read([])).toEqual([])
  })

  test("encodes a PNG as a base64 data URL with the detected MIME type", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    expect(await read(["ref.png"])).toEqual([dataUrl(PNG)])
  })

  // The MIME type comes from file-type's content sniffing, not the extension, so cover a
  // few non-PNG formats to confirm the detected type (not a hard-coded "image/png") is used.
  // Each case is a minimal header file-type recognizes from its magic bytes.
  const formats: Array<{ name: string; mime: string; bytes: Buffer }> = [
    { name: "JPEG", mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    { name: "GIF", mime: "image/gif", bytes: Buffer.from("GIF89a") },
    {
      name: "WebP",
      mime: "image/webp",
      bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    },
    { name: "BMP", mime: "image/bmp", bytes: Buffer.concat([Buffer.from("BM"), Buffer.alloc(16)]) },
  ]
  for (const { name, mime, bytes } of formats) {
    test(`detects a ${name} file and uses its MIME type in the data URL`, async () => {
      const file = `ref-${name.toLowerCase()}`
      await writeFile(path.join(dir, file), bytes)
      expect(await read([file])).toEqual([`data:${mime};base64,${bytes.toString("base64")}`])
    })
  }

  test("resolves relative paths against the context directory", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    const abs = path.join(dir, "ref.png")
    const [viaRelative] = await read(["ref.png"])
    const [viaAbsolute] = await read([abs], "/some/other/ctx")
    expect(viaRelative).toBe(viaAbsolute)
  })

  test("preserves the input order across multiple images", async () => {
    // A second PNG with extra trailing bytes: still detected as PNG, but distinct base64.
    const png2 = Buffer.concat([PNG, Buffer.from("trailer")])
    await writeFile(path.join(dir, "first.png"), PNG)
    await writeFile(path.join(dir, "second.png"), png2)
    expect(await read(["first.png", "second.png"])).toEqual([dataUrl(PNG), dataUrl(png2)])
  })

  test("throws when a file is not a recognized image", async () => {
    const abs = path.join(dir, "notes.txt")
    await writeFile(abs, "this is plain text, not an image")
    await expect(read(["notes.txt"])).rejects.toThrow(`unsupported image file type: ${abs}`)
  })

  test("rejects the whole call with the missing path when any path is missing", async () => {
    await writeFile(path.join(dir, "present.png"), PNG)

    const error = await read(["present.png", "missing.png"]).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: "ENOENT", path: path.join(dir, "missing.png") })
  })

  test.each(["C:\\images\\ref.png", "C:/images/ref.png", "C:ref.png"])(
    "reads the Windows drive path %s as a local path, not a URL",
    async (entry) => {
      const { source, events } = sourceFor(dir)
      const fetchMock = mock(async () => new Response(PNG))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const error = await readReferenceImages([entry], source).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ code: "ENOENT" })
      expect(events).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})

type FetchCall = [url: URL, init: RequestInit]

// Answers each fetch with the next response, recording the call after the authorization events before it.
function stubFetch(events: string[], ...responses: Array<() => Response | Promise<Response>>) {
  const fetchMock = mock(async (url: URL, _init: RequestInit) => {
    events.push(`fetch ${url.href}`)
    const next = responses.shift()
    if (!next) throw new Error("unexpected fetch")
    return next()
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock as unknown as { mock: { calls: FetchCall[] } } & typeof fetchMock
}

const redirect =
  (location: string | null, status = 302) =>
  () =>
    new Response(null, { status, headers: location === null ? {} : { location } })

describe("readReferenceImages from https URLs", () => {
  test("downloads after the host allows the URL, without credentials or automatic redirects", async () => {
    const { source, events } = sourceFor(dir)
    const fetchMock = stubFetch(events, () => new Response(PNG))
    const url = "https://cdn.example.com/ref.png?token=secret"

    const { references } = await readReferenceImages([url], source)

    expect(references).toEqual([dataUrl(PNG)])
    expect(events).toEqual([`authorize ${url}`, `fetch ${url}`])
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("manual")
    expect(init.headers).toBeUndefined()
  })

  test("a denied webfetch permission stops before the URL is fetched", async () => {
    const { source, events, deny } = sourceFor(dir)
    const fetchMock = stubFetch(events, () => new Response(PNG))
    deny(new Error("webfetch denied"))

    await expect(readReferenceImages(["https://cdn.example.com/ref.png"], source)).rejects.toThrow("webfetch denied")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("each hop's timeout is a whole-millisecond share of the network budget, not counting permission waits", async () => {
    let now = 1000.25
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    const timeouts: number[] = []
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms)
      return new AbortController().signal
    })
    try {
      const source: ReferenceSource = {
        directory: dir,
        signal: new AbortController().signal,
        authorizeFetch: async () => {
          now += 8000
        },
      }
      const after = (respond: () => Response) => () => {
        now += 250.4
        return respond()
      }
      stubFetch(
        [],
        after(redirect("https://cdn.example.com/next.png")),
        after(() => new Response(PNG)),
      )

      await readReferenceImages(["https://cdn.example.com/ref.png"], source)

      // 250.4 ms of network time on the first hop leaves 29749.6 ms, rounded up; the 8 s permission waits are free.
      expect(timeouts).toEqual([30_000, 29_750])
    } finally {
      clock.mockRestore()
      timeout.mockRestore()
    }
  })

  test("a denied URL stops the URLs queued behind it before the host is asked about them", async () => {
    const denial = new Error("webfetch denied")
    const authorizeFetch = mock(async (_url: string) => {
      await new Promise((resolve) => setImmediate(resolve))
      throw denial
    })
    const source: ReferenceSource = { directory: dir, signal: new AbortController().signal, authorizeFetch }
    const fetchMock = stubFetch([], () => new Response(PNG))

    await expect(
      readReferenceImages(["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"], source),
    ).rejects.toBe(denial)
    // The call rejects on the first failure; let the queued URL's turn come before checking it was never asked.
    await new Promise((resolve) => setImmediate(resolve))
    expect(authorizeFetch).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("follows three redirects, validating and authorizing each hop before fetching it", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(
      events,
      redirect("https://a.example.com/one"),
      redirect("/two", 301),
      redirect("https://b.example.com/three", 307),
      () => new Response(PNG),
    )

    const { references } = await readReferenceImages(["https://start.example.com/ref.png"], source)

    expect(references).toEqual([dataUrl(PNG)])
    expect(events).toEqual([
      "authorize https://start.example.com/ref.png",
      "fetch https://start.example.com/ref.png",
      "authorize https://a.example.com/one",
      "fetch https://a.example.com/one",
      "authorize https://a.example.com/two",
      "fetch https://a.example.com/two",
      "authorize https://b.example.com/three",
      "fetch https://b.example.com/three",
    ])
  })

  test("refuses a fourth redirect", async () => {
    const { source, events } = sourceFor(dir)
    const fetchMock = stubFetch(
      events,
      redirect("https://a.example.com/1"),
      redirect("https://a.example.com/2"),
      redirect("https://a.example.com/3"),
      redirect("https://a.example.com/4"),
    )

    await expect(readReferenceImages(["https://start.example.com/ref.png"], source)).rejects.toThrow(
      "could not download reference image https://a.example.com/3: too many redirects (max 3).",
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test.each([
    ["an http URL", "http://cdn.example.com/x.png", "it is not an https URL."],
    ["a localhost URL", "https://localhost/x.png", "its host is an IP address or localhost."],
    ["an IPv4 literal", "https://169.254.169.254/latest", "its host is an IP address or localhost."],
  ])("refuses a redirect to %s without authorizing or fetching it", async (_name, target, reason) => {
    const { source, events } = sourceFor(dir)
    const fetchMock = stubFetch(events, redirect(target))

    await expect(readReferenceImages(["https://start.example.com/ref.png"], source)).rejects.toThrow(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(["authorize https://start.example.com/ref.png", "fetch https://start.example.com/ref.png"])
  })

  test("refuses a redirect without a Location header", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, redirect(null))

    await expect(readReferenceImages(["https://start.example.com/ref.png"], source)).rejects.toThrow(
      "it answered HTTP 302 without a Location header.",
    )
  })

  test.each([
    ["http", "http://cdn.example.com/x.png?token=secret", "it is not an https URL."],
    ["file", "file:///etc/passwd", "it is not an https URL."],
    ["ftp", "ftp://cdn.example.com/x.png", "it is not an https URL."],
    ["data", `data:image/png;base64,${PNG.toString("base64")}`, "it is not an https URL."],
    ["localhost", "https://localhost/x.png", "its host is an IP address or localhost."],
    ["IPv4", "https://127.0.0.1/x.png", "its host is an IP address or localhost."],
    ["IPv6", "https://[::1]/x.png", "its host is an IP address or localhost."],
    ["credentials", "https://user:pw@cdn.example.com/x.png", "it contains credentials."],
  ])("refuses a %s URL before asking permission or fetching", async (_name, url, reason) => {
    const { source, events } = sourceFor(dir)
    const fetchMock = stubFetch(events, () => new Response(PNG))

    const error = (await readReferenceImages([url], source).catch((caught: Error) => caught)) as Error

    expect(error.message).toContain(reason)
    expect(error.message).not.toMatch(/secret|base64,|pw@/)
    expect(events).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("reports an HTTP failure with the URL's origin and path only, not the query or body", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, () => new Response("private body", { status: 403 }))

    const error = (await readReferenceImages(["https://cdn.example.com/ref.png?sig=secret#frag"], source).catch(
      (caught: Error) => caught,
    )) as Error

    expect(error.message).toBe("could not download reference image https://cdn.example.com/ref.png: HTTP 403.")
  })

  test("reports a transport failure without the runtime's message, which can repeat the full URL", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, () => {
      throw new TypeError("fetch failed for https://cdn.example.com/ref.png?sig=secret")
    })

    const error = (await readReferenceImages(["https://cdn.example.com/ref.png?sig=secret"], source).catch(
      (caught: Error) => caught,
    )) as Error

    expect(error.message).toBe(
      "could not download reference image https://cdn.example.com/ref.png: the request failed or timed out after 30 s.",
    )
  })

  test("rejects with the cancellation reason when the call is cancelled during a download", async () => {
    const controller = new AbortController()
    const { source, events } = sourceFor(dir, controller.signal)
    const reason = new Error("stopped by the user")
    stubFetch(events, () => {
      controller.abort(reason)
      throw new DOMException("aborted", "AbortError")
    })

    await expect(readReferenceImages(["https://cdn.example.com/ref.png"], source)).rejects.toBe(reason)
  })

  test("passes a signal that the call's cancellation aborts", async () => {
    const controller = new AbortController()
    const { source, events } = sourceFor(dir, controller.signal)
    const fetchMock = stubFetch(events, () => new Response(PNG))

    await readReferenceImages(["https://cdn.example.com/ref.png"], source)
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    controller.abort()

    expect(signal.aborted).toBe(true)
  })

  test("refuses a download above 20 MiB even when the backend allows more", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, () => new Response(PNG, { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }))

    await expect(
      readReferenceImages(["https://cdn.example.com/big.png?sig=secret"], source, { maxBytes: 50 * 1024 * 1024 }),
    ).rejects.toThrow(
      "could not download reference image https://cdn.example.com/big.png: it declares 20971521 bytes and the limit is 20971520.",
    )
  })

  test("uses the backend's smaller size limit for a download", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, () => new Response(Buffer.concat([PNG, Buffer.alloc(100)])))

    await expect(
      readReferenceImages(["https://cdn.example.com/ref.png"], source, { maxBytes: PNG.length }),
    ).rejects.toThrow(`it is larger than the limit of ${PNG.length} bytes.`)
  })

  test("applies the same type checks to downloaded bytes, naming the URL without its query", async () => {
    const { source, events } = sourceFor(dir)
    stubFetch(events, () => new Response("<html>not an image</html>"))

    await expect(readReferenceImages(["https://cdn.example.com/ref.png?sig=secret"], source)).rejects.toThrow(
      /^unsupported image file type: https:\/\/cdn\.example\.com\/ref\.png$/,
    )
  })

  test("loads at most four references at a time and keeps their order", async () => {
    const { source } = sourceFor(dir)
    let inFlight = 0
    let peak = 0
    const pending: Array<() => void> = []
    globalThis.fetch = mock(async (url: URL) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => pending.push(resolve))
      inFlight--
      return new Response(Buffer.concat([PNG, Buffer.from(url.pathname)]))
    }) as unknown as typeof fetch
    const urls = Array.from({ length: 6 }, (_, index) => `https://cdn.example.com/${index}.png`)

    let settled = false
    const loading = readReferenceImages(urls, source).finally(() => {
      settled = true
    })
    // Release downloads newest first, so completion order differs from the requested order.
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve))
      pending.pop()?.()
    }
    const loaded = await loading

    expect(peak).toBe(4)
    expect(loaded.references).toEqual(
      urls.map((url) => dataUrl(Buffer.concat([PNG, Buffer.from(new URL(url).pathname)]))),
    )
  })

  test("asks the host about one URL at a time while the downloads run together", async () => {
    let asking = 0
    let peakAsking = 0
    const answers: Array<() => void> = []
    const source: ReferenceSource = {
      directory: dir,
      signal: new AbortController().signal,
      authorizeFetch: async () => {
        asking++
        peakAsking = Math.max(peakAsking, asking)
        await new Promise<void>((resolve) => answers.push(resolve))
        asking--
      },
    }
    let downloading = 0
    const downloads: Array<() => void> = []
    globalThis.fetch = mock(async () => {
      downloading++
      await new Promise<void>((resolve) => downloads.push(resolve))
      return new Response(PNG)
    }) as unknown as typeof fetch
    const urls = Array.from({ length: 3 }, (_, index) => `https://cdn.example.com/${index}.png`)

    const loading = readReferenceImages(urls, source)
    while (downloading < urls.length) {
      await new Promise((resolve) => setImmediate(resolve))
      answers.shift()?.()
    }
    for (const release of downloads) release()

    expect((await loading).references).toEqual(urls.map(() => dataUrl(PNG)))
    expect(peakAsking).toBe(1)
    expect(downloading).toBe(3)
  })

  test("a failed reference cancels a sibling's download, and its redirect is neither authorized nor fetched", async () => {
    const { source, events } = sourceFor(dir)
    let siblingSignal: AbortSignal | undefined
    let answerSibling: (response: Response) => void = () => {}
    globalThis.fetch = mock(async (url: URL, init: RequestInit) => {
      events.push(`fetch ${url.href}`)
      if (url.hostname === "bad.example.com") return new Response("denied", { status: 403 })
      siblingSignal = init.signal as AbortSignal
      return new Promise<Response>((resolve) => {
        answerSibling = resolve
      })
    }) as unknown as typeof fetch

    await expect(
      readReferenceImages(["https://slow.example.com/ref.png", "https://bad.example.com/ref.png"], source),
    ).rejects.toThrow("could not download reference image https://bad.example.com/ref.png: HTTP 403.")
    expect(siblingSignal?.aborted).toBe(true)
    answerSibling(new Response(null, { status: 302, headers: { location: "https://slow.example.com/next.png" } }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.includes("next.png"))).toEqual([])
  })

  test("a call cancelled before it starts asks for no permission and fetches nothing", async () => {
    const controller = new AbortController()
    const reason = new Error("stopped by the user")
    controller.abort(reason)
    const { source, events } = sourceFor(dir, controller.signal)
    const fetchMock = stubFetch(events, () => new Response(PNG))

    await expect(readReferenceImages(["https://cdn.example.com/ref.png"], source)).rejects.toBe(reason)
    expect(events).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
