import { expect, test } from "bun:test"
import { HttpError } from "./configApi"
import {
  relayErrorMessage,
  toPairingStart,
  toPollResult,
  toRelayStatus,
} from "./relayApi"

// ---- status ---------------------------------------------------------------

test("maps a paired status with peers", () => {
  const status = toRelayStatus({
    paired: true,
    enabled: true,
    relayUrl: "https://relay.chunky.to",
    peers: [{ deviceId: "d1", name: "Max's iPhone" }],
  })
  expect(status).toEqual({
    paired: true,
    enabled: true,
    relayUrl: "https://relay.chunky.to",
    peers: [{ deviceId: "d1", name: "Max's iPhone" }],
  })
})

test("defaults missing/blank status fields safely", () => {
  expect(toRelayStatus({})).toEqual({ paired: false, enabled: true, relayUrl: null, peers: [] })
  expect(toRelayStatus(null)).toEqual({ paired: false, enabled: true, relayUrl: null, peers: [] })
  // enabled:false is the CHUNKY_RELAY=0 case and must survive verbatim.
  expect(toRelayStatus({ paired: true, enabled: false }).enabled).toBe(false)
  expect(toRelayStatus({ relayUrl: "   " }).relayUrl).toBe(null)
})

test("drops unusable peers and falls back to the id for a nameless one", () => {
  const status = toRelayStatus({
    peers: [{ name: "no id" }, { deviceId: "d2" }, null, "nope", { deviceId: "d3", name: "Phone" }],
  })
  expect(status.peers).toEqual([
    { deviceId: "d2", name: "d2" },
    { deviceId: "d3", name: "Phone" },
  ])
})

test("SECURITY: view models retain only contract fields, never secret-bearing extras", () => {
  const status = toRelayStatus({
    paired: true,
    enabled: true,
    relayUrl: "https://relay.chunky.to",
    deviceToken: "tok_SECRET",
    secretKey: "sk_SECRET",
    peers: [{ deviceId: "d1", name: "Phone", pubKey: "pk_SECRET", token: "t_SECRET" }],
  })
  expect(Object.keys(status).sort()).toEqual(["enabled", "paired", "peers", "relayUrl"])
  expect(Object.keys(status.peers[0]!).sort()).toEqual(["deviceId", "name"])
  expect(JSON.stringify(status)).not.toContain("SECRET")

  const start = toPairingStart({
    qrPayload: "chunky1:abc",
    relayUrl: "https://relay.chunky.to",
    name: "Mac",
    expiresAt: 123,
    deviceToken: "tok_SECRET",
    secretKey: "sk_SECRET",
  })
  expect(Object.keys(start).sort()).toEqual(["expiresAt", "name", "qrPayload", "relayUrl"])
  expect(JSON.stringify(start)).not.toContain("SECRET")

  const claimed = toPollResult({
    status: "claimed",
    peer: { deviceId: "d1", name: "Phone", deviceToken: "tok_SECRET" },
  })
  expect(JSON.stringify(claimed)).not.toContain("SECRET")
})

// ---- begin ----------------------------------------------------------------

test("maps a begin response and defaults a missing name", () => {
  expect(
    toPairingStart({ qrPayload: "chunky1:abc", relayUrl: "https://r", name: "Mac", expiresAt: 99 }),
  ).toEqual({ qrPayload: "chunky1:abc", relayUrl: "https://r", name: "Mac", expiresAt: 99 })

  expect(toPairingStart({ qrPayload: "chunky1:abc", relayUrl: "https://r", expiresAt: 99 }).name).toBe(
    "This computer",
  )
})

test("rejects an incomplete begin response rather than showing a broken QR", () => {
  expect(() => toPairingStart({ relayUrl: "https://r", expiresAt: 1 })).toThrow(/incomplete/i)
  expect(() => toPairingStart({ qrPayload: "chunky1:abc", expiresAt: 1 })).toThrow(/incomplete/i)
  expect(() => toPairingStart({ qrPayload: "chunky1:abc", relayUrl: "https://r" })).toThrow(/incomplete/i)
  expect(() => toPairingStart(null)).toThrow(/incomplete/i)
})

// ---- poll -----------------------------------------------------------------

test("maps every poll status from the contract", () => {
  expect(toPollResult({ status: "pending", expiresAt: 42 })).toEqual({ status: "pending", expiresAt: 42 })
  expect(toPollResult({ status: "claimed", peer: { deviceId: "d1", name: "Phone" } })).toEqual({
    status: "claimed",
    peer: { deviceId: "d1", name: "Phone" },
  })
  expect(toPollResult({ status: "expired" })).toEqual({ status: "expired" })
  expect(toPollResult({ status: "error", error: "relay unreachable" })).toEqual({
    status: "error",
    error: "relay unreachable",
  })
})

test("degrades unknown or malformed poll payloads to a readable error", () => {
  expect(toPollResult({ status: "wat" })).toEqual({
    status: "error",
    error: "The server returned an unknown pairing status.",
  })
  expect(toPollResult(null).status).toBe("error")
  expect(toPollResult({ status: "error" })).toEqual({ status: "error", error: "Pairing failed." })
  // A claim without a usable peer is still a successful claim.
  expect(toPollResult({ status: "claimed" })).toEqual({
    status: "claimed",
    peer: { deviceId: "", name: "Your phone" },
  })
  expect(toPollResult({ status: "pending" })).toEqual({ status: "pending", expiresAt: 0 })
})

// ---- errors ---------------------------------------------------------------

test("explains an old server separately from a real failure", () => {
  expect(relayErrorMessage(new HttpError("nope", 404, "Not Found"))).toMatch(/doesn't support relay/i)
  expect(relayErrorMessage(new HttpError("nope", 501, null))).toMatch(/doesn't support relay/i)
  expect(relayErrorMessage(new HttpError("relay is down", 500, { error: "relay is down" }))).toBe(
    "relay is down",
  )
  expect(relayErrorMessage(new Error("Can't reach the Chunky server"))).toBe(
    "Can't reach the Chunky server",
  )
  expect(relayErrorMessage({})).toBe("Relay request failed.")
})
