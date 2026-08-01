import { expect, test } from "bun:test"
import { QR_QUIET_ZONE, qrPath } from "./qr"

/** A realistic canonical pairing string (chunky1: + base64url JSON, ~290 chars). */
function pairingPayload(): string {
  const json = JSON.stringify({
    v: 1,
    relay: "https://relay.chunky.to",
    code: "ABCD1234",
    computerPubKey: "A".repeat(44),
    secret: "B".repeat(44),
    name: "Maxs-MacBook-Pro.local",
  })
  return `chunky1:${btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`
}

test("encodes a full pairing payload and reports its geometry", () => {
  const payload = pairingPayload()
  expect(payload.length).toBeGreaterThan(250)

  const qr = qrPath(payload)
  // Version 13 => 17 + 4*13 = 69 modules per side for a ~290 char byte payload.
  expect(qr.version).toBe(13)
  expect(qr.modules).toBe(69)
  expect(qr.d.length).toBeGreaterThan(1000)
})

test("adds exactly one 4-module quiet zone (uqr's default border is not doubled)", () => {
  const qr = qrPath(pairingPayload())
  expect(QR_QUIET_ZONE).toBe(4)
  // span = modules + border on both sides. If uqr's default 1-module border
  // leaked through, this would be modules + 10.
  expect(qr.span).toBe(qr.modules + QR_QUIET_ZONE * 2)
})

test("offsets every module by the quiet zone and never draws outside the viewBox", () => {
  const qr = qrPath("chunky1:test", { border: 4 })
  const coords = [...qr.d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => [Number(x), Number(y)])
  expect(coords.length).toBeGreaterThan(0)
  for (const [x, y] of coords) {
    expect(x).toBeGreaterThanOrEqual(4)
    expect(y).toBeGreaterThanOrEqual(4)
    expect(x).toBeLessThan(qr.span - 4)
    expect(y).toBeLessThan(qr.span - 4)
  }
  // The top-left finder pattern's first module sits exactly at the border.
  expect(coords.some(([x, y]) => x === 4 && y === 4)).toBe(true)
})

test("honours a custom border", () => {
  const qr = qrPath("chunky1:test", { border: 0 })
  expect(qr.span).toBe(qr.modules)
  expect(qr.d.startsWith("M0 0")).toBe(true)
})

test("higher error correction produces a larger symbol for the same payload", () => {
  const payload = pairingPayload()
  const m = qrPath(payload, { ecc: "M" })
  const h = qrPath(payload, { ecc: "H" })
  expect(h.modules).toBeGreaterThan(m.modules)
})

test("empty text yields an empty path instead of throwing", () => {
  const qr = qrPath("")
  expect(qr.d).toBe("")
  expect(qr.modules).toBe(0)
  expect(qr.version).toBe(0)
  expect(qr.span).toBe(QR_QUIET_ZONE * 2)
})

test("path data is geometry only — it never embeds the payload", () => {
  const payload = pairingPayload()
  const qr = qrPath(payload)
  expect(qr.d).not.toContain("chunky1")
  expect(/^[Mhvz0-9 .-]+$/.test(qr.d)).toBe(true)
})
