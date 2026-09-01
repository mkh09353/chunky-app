import { describe, expect, test } from "bun:test"
import {
  browserDevLabel,
  connectionStatusLabel,
  formatSafeServerTarget,
  isBrowserDevLabel,
  isViteDevOrigin,
} from "./connectionSource"

describe("isViteDevOrigin", () => {
  test("matches the Vite HMR origins and nothing else", () => {
    expect(isViteDevOrigin("http://localhost:5173")).toBe(true)
    expect(isViteDevOrigin("http://127.0.0.1:5173")).toBe(true)
    expect(isViteDevOrigin("views://mainview")).toBe(false)
    expect(isViteDevOrigin("http://localhost:4620")).toBe(false)
    expect(isViteDevOrigin(undefined)).toBe(false)
  })
})

describe("formatSafeServerTarget", () => {
  test("renders host:port from an http URL", () => {
    expect(formatSafeServerTarget("http://localhost:4699")).toBe("localhost:4699")
    expect(formatSafeServerTarget("http://127.0.0.1:4620")).toBe("127.0.0.1:4620")
  })

  test("fills the default port when the URL omits it", () => {
    expect(formatSafeServerTarget("http://localhost")).toBe("localhost:80")
    expect(formatSafeServerTarget("https://example.com")).toBe("example.com:443")
  })

  test("strips credentials, path, and query so they never appear in chrome", () => {
    expect(formatSafeServerTarget("http://user:secret@localhost:4699/hidden?token=abc")).toBe(
      "localhost:4699",
    )
    expect(browserDevLabel("http://user:secret@localhost:4699/hidden?token=abc")).toBe(
      "Dev web · localhost:4699",
    )
    expect(browserDevLabel("http://user:secret@localhost:4699/hidden?token=abc")).not.toContain("secret")
    expect(browserDevLabel("http://user:secret@localhost:4699/hidden?token=abc")).not.toContain("token")
  })

  test("rejects non-http URLs and junk", () => {
    expect(formatSafeServerTarget("file:///tmp/chunky.db")).toBe("")
    expect(formatSafeServerTarget("/chunky-api")).toBe("")
    expect(formatSafeServerTarget("")).toBe("")
    expect(formatSafeServerTarget(undefined)).toBe("")
  })
})

describe("browserDevLabel", () => {
  test("names the configured proxy target", () => {
    expect(browserDevLabel("http://localhost:4699")).toBe("Dev web · localhost:4699")
  })

  test("falls back to the Vite default when the target is missing or unsafe", () => {
    expect(browserDevLabel(undefined)).toBe("Dev web · localhost:4620")
    expect(browserDevLabel("/chunky-api")).toBe("Dev web · localhost:4620")
  })
})

describe("connectionStatusLabel", () => {
  test("browser-dev stays identified even while connecting or offline", () => {
    const vite = { appMode: "live" as const, connectionSource: "vite-proxy" as const, proxyTarget: "http://localhost:4699" }
    expect(connectionStatusLabel({ ...vite, connectionState: "connected" })).toBe("Dev web · localhost:4699")
    expect(connectionStatusLabel({ ...vite, connectionState: "connecting" })).toBe("Dev web · localhost:4699")
    expect(connectionStatusLabel({ ...vite, connectionState: "offline" })).toBe("Dev web · localhost:4699")
  })

  test("packaged native still reads as Live when connected", () => {
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "connected",
      connectionSource: "native",
    })).toBe("Live")
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "connecting",
      connectionSource: "native",
    })).toBe("Connecting")
  })

  test("demo beats every live label", () => {
    expect(connectionStatusLabel({
      appMode: "demo",
      connectionState: "connected",
      connectionSource: "vite-proxy",
      proxyTarget: "http://localhost:4699",
    })).toBe("Demo")
  })

  test("Dev web labels are classified as browser-dev, Live is not", () => {
    expect(isBrowserDevLabel("Dev web · localhost:4699")).toBe(true)
    expect(isBrowserDevLabel("Live")).toBe(false)
  })

  test("first paint on a Vite origin is Dev web even before AppConfig", () => {
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "booting",
      origin: "http://localhost:5173",
    })).toBe("Dev web · localhost:4620")
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "offline",
      origin: "http://127.0.0.1:5173",
      proxyTarget: "http://localhost:4699",
    })).toBe("Dev web · localhost:4699")
  })

  test("packaged origin without a vite source still reads Connecting then Live", () => {
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "booting",
      origin: "views://mainview",
    })).toBe("Connecting")
    expect(connectionStatusLabel({
      appMode: "live",
      connectionState: "connected",
      origin: "views://mainview",
      connectionSource: "native",
    })).toBe("Live")
  })
})
