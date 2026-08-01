import { expect, test } from "bun:test"
import { ROUTES } from "@chunky/protocol"
import {
  authLogoutRoute,
  authTestRoute,
  logoutProvider,
  testProviderAuth,
  UNSUPPORTED_LOGOUT,
  UNSUPPORTED_TEST,
  type AuthRouteTable,
} from "./configApi"

// Regression guard for the v0.1.16 crash: a packaged renderer whose bundled
// @chunky/protocol snapshot predates the auth routes still calls them, so
// `ROUTES.authTest` is typed but undefined and `zt.authTest(...)` throws.
// Every route lookup must survive that and degrade to the existing
// "unsupported" behavior. The routes table is injected, so none of this
// mutates the canonical ROUTES.

/** A ROUTES snapshot from before the auth routes existed. */
const OLD_BUNDLE: AuthRouteTable = {}

test("resolvers build the real paths when the helpers exist", () => {
  expect(authTestRoute(ROUTES, "codex")).toBe("/api/auth/codex/test")
  expect(authLogoutRoute(ROUTES, "codex")).toBe("/api/auth/codex/logout")
  // Provider ids are encoded by the canonical route builders.
  expect(authTestRoute(ROUTES, "my provider/x")).toBe("/api/auth/my%20provider%2Fx/test")
})

test("resolvers return null instead of throwing when the helper is missing", () => {
  expect(authTestRoute(OLD_BUNDLE, "codex")).toBe(null)
  expect(authLogoutRoute(OLD_BUNDLE, "codex")).toBe(null)
})

test("resolvers tolerate every non-function shape a stale snapshot can carry", () => {
  for (const value of [undefined, null, "", "/api/auth/codex/test", 42, {}, []]) {
    const routes = { authTest: value, authLogout: value } as AuthRouteTable
    expect(authTestRoute(routes, "codex")).toBe(null)
    expect(authLogoutRoute(routes, "codex")).toBe(null)
  }
})

test("a route builder returning a non-string is treated as unavailable", () => {
  const routes: AuthRouteTable = { authTest: () => undefined, authLogout: () => "" }
  expect(authTestRoute(routes, "codex")).toBe(null)
  expect(authLogoutRoute(routes, "codex")).toBe(null)
})

test("a broken route builder is treated as unavailable", () => {
  const broken = () => {
    throw new TypeError("stale route builder")
  }
  const routes: AuthRouteTable = { authTest: broken, authLogout: broken }
  expect(authTestRoute(routes, "codex")).toBe(null)
  expect(authLogoutRoute(routes, "codex")).toBe(null)
})

test("testProviderAuth degrades gracefully instead of throwing a TypeError", async () => {
  // No network is touched: the guard returns before any request is made.
  const result = await testProviderAuth("codex", OLD_BUNDLE)
  expect(result).toEqual({ ok: false, unsupported: true, error: UNSUPPORTED_TEST })
  expect(result.error).toContain("does not support testing a provider connection")
})

test("logoutProvider throws the existing unsupported error, not a TypeError", async () => {
  let caught: unknown
  try {
    await logoutProvider("codex", OLD_BUNDLE)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  expect(caught).not.toBeInstanceOf(TypeError)
  expect((caught as Error).message).toBe(UNSUPPORTED_LOGOUT)
})

test("the canonical ROUTES still carries both auth helpers (skew canary)", () => {
  // If this fails, the app is being built against a protocol that predates the
  // auth routes — exactly the skew the build typecheck gate is there to catch.
  expect(typeof ROUTES.authTest).toBe("function")
  expect(typeof ROUTES.authLogout).toBe("function")
})
