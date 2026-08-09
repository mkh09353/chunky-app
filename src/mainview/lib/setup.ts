import { createSession, sendMessage } from "./api"
import { getRpc, nativeRpcAvailable, type RpcClient } from "./rpc"
import type { SetupSessionMeta, ZooCredentialMeta } from "../../shared/zooTypes"

export type { SetupSessionMeta, ZooCredentialMeta } from "../../shared/zooTypes"
export type SetupResult<T> = ({ ok: true } & T) | { ok: false; error: string }

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const string = (value: unknown): value is string => typeof value === "string"
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export function parseSetupSession(value: unknown): SetupSessionMeta | null {
  const row = object(value)
  return row && string(row.sessionId) && string(row.title) && finite(row.createdAt) && finite(row.lastActivityAt)
    ? { sessionId: row.sessionId, title: row.title, createdAt: row.createdAt, lastActivityAt: row.lastActivityAt } : null
}
export function parseCredential(value: unknown): ZooCredentialMeta | null {
  const row = object(value)
  return row && string(row.name) && finite(row.createdAt) ? { name: row.name, createdAt: row.createdAt } : null
}
export function parseSetupSessions(value: unknown): SetupResult<{ sessions: SetupSessionMeta[] }> {
  const row = object(value); if (row?.ok === false && string(row.error)) return { ok: false, error: row.error }
  if (!row || row.ok !== true || !Array.isArray(row.sessions)) return { ok: false, error: "Invalid setup sessions response." }
  const sessions = row.sessions.map(parseSetupSession)
  return sessions.every((entry): entry is SetupSessionMeta => entry !== null) ? { ok: true, sessions } : { ok: false, error: "Invalid setup sessions response." }
}
export function parseCredentialList(value: unknown): SetupResult<{ credentials: ZooCredentialMeta[] }> {
  const row = object(value); if (row?.ok === false && string(row.error)) return { ok: false, error: row.error }
  if (!row || row.ok !== true || !Array.isArray(row.credentials)) return { ok: false, error: "Invalid credential response." }
  const credentials = row.credentials.map(parseCredential)
  return credentials.every((entry): entry is ZooCredentialMeta => entry !== null) ? { ok: true, credentials } : { ok: false, error: "Invalid credential response." }
}
export function parseCredentialResult(value: unknown): SetupResult<{ credential: ZooCredentialMeta }> {
  const row = object(value); if (row?.ok === false && string(row.error)) return { ok: false, error: row.error }
  const credential = row?.ok === true ? parseCredential(row.credential) : null
  return credential ? { ok: true, credential } : { ok: false, error: "Invalid credential response." }
}
export function parseSessionResult(value: unknown): SetupResult<{ session: SetupSessionMeta }> {
  const row = object(value); if (row?.ok === false && string(row.error)) return { ok: false, error: row.error }
  const session = row?.ok === true ? parseSetupSession(row.session) : null
  return session ? { ok: true, session } : { ok: false, error: "Invalid setup session response." }
}
export function parseOk(value: unknown): SetupResult<Record<never, never>> {
  const row = object(value); if (row?.ok === false && string(row.error)) return { ok: false, error: row.error }
  return row?.ok === true ? { ok: true } : { ok: false, error: "Invalid native response." }
}
async function rpc(): Promise<RpcClient | null> { return nativeRpcAvailable() ? getRpc() : null }
async function request(name: string, args: unknown): Promise<unknown> { const client = await rpc(); return client?.request?.[name]?.(args) }
const unavailable = (noun: string) => ({ ok: false as const, error: `${noun} are available in the desktop app.` })

export async function ensureLedgerSkill(): Promise<SetupResult<Record<never, never>>> {
  if (!nativeRpcAvailable()) return unavailable("Setup skills")
  try { return parseOk(await request("zooEnsureLedgerSkill", {})) } catch { return { ok: false, error: "Could not install the Zoo setup skill. Retry setup." } }
}
export async function listSetupSessions(): Promise<SetupResult<{ sessions: SetupSessionMeta[] }>> {
  if (!nativeRpcAvailable()) return unavailable("Setup sessions")
  try { return parseSetupSessions(await request("zooListSetupSessions", {})) } catch { return { ok: false, error: "Could not load setup sessions." } }
}
export async function recordSetupSession(input: { sessionId: string; title?: string }): Promise<SetupResult<{ session: SetupSessionMeta }>> {
  if (!nativeRpcAvailable()) return unavailable("Setup sessions")
  try { return parseSessionResult(await request("zooRecordSetupSession", input)) } catch { return { ok: false, error: "Could not save the setup session." } }
}
export async function listCredentials(): Promise<SetupResult<{ credentials: ZooCredentialMeta[] }>> {
  if (!nativeRpcAvailable()) return unavailable("Named credentials")
  try { return parseCredentialList(await request("zooListCredentials", {})) } catch { return { ok: false, error: "Could not load saved credential names." } }
}
export async function setCredential(name: string, value: string): Promise<SetupResult<{ credential: ZooCredentialMeta }>> {
  if (!nativeRpcAvailable()) return unavailable("Named credentials")
  try { return parseCredentialResult(await request("zooSetCredential", { name, value })) } catch { return { ok: false, error: "Could not save the credential." } }
}
export async function deleteCredential(name: string): Promise<SetupResult<Record<never, never>>> {
  if (!nativeRpcAvailable()) return unavailable("Named credentials")
  try { return parseOk(await request("zooDeleteCredential", { name })) } catch { return { ok: false, error: "Could not delete the credential." } }
}

export interface SetupStartDeps {
  ensure: () => Promise<SetupResult<Record<never, never>>>
  create: (baseUrl: string, repoId: string) => Promise<{ sessionId: string }>
  send: (baseUrl: string, sessionId: string, message: string, options: { skill: string }) => Promise<unknown>
  record: (input: { sessionId: string; title?: string }) => Promise<SetupResult<{ session: SetupSessionMeta }>>
}
export async function startSetupSessionWithDeps(baseUrl: string | null | undefined, repoId: string | null | undefined, message: string, deps: SetupStartDeps): Promise<SetupResult<{ sessionId: string }>> {
  if (!baseUrl) return { ok: false, error: "Connect to Chunky before starting setup." }
  if (!repoId) return { ok: false, error: "Select a repository or configure this area's repository before starting setup." }
  const text = message.trim(); if (!text) return { ok: false, error: "Describe the source or workflow you want to set up." }
  const installed = await deps.ensure(); if (!installed.ok) return installed
  let sessionId: string
  try { sessionId = (await deps.create(baseUrl, repoId)).sessionId } catch { return { ok: false, error: "Could not create the setup session. Retry when Chunky is available." } }
  try { await deps.send(baseUrl, sessionId, text, { skill: "zoo-ledger" }) } catch { return { ok: false, error: "Could not start the skilled setup conversation. Check the skill installation and retry." } }
  try { await deps.record({ sessionId, title: text.slice(0, 60) }) } catch { /* optional local index */ }
  return { ok: true, sessionId }
}
export function startSetupSession(baseUrl: string | null | undefined, repoId: string | null | undefined, message: string): Promise<SetupResult<{ sessionId: string }>> {
  return startSetupSessionWithDeps(baseUrl, repoId, message, { ensure: ensureLedgerSkill, create: createSession as SetupStartDeps["create"], send: sendMessage, record: recordSetupSession })
}
