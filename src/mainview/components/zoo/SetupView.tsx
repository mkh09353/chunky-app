import { KeyRound, LoaderCircle, MessagesSquare, Trash2 } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { relativeTime } from "~/lib/format"
import { deleteCredential, listCredentials, listSetupSessions, setCredential, startSetupSession, type SetupSessionMeta, type ZooCredentialMeta } from "~/lib/setup"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { EmptyState, Notice, ViewHeader } from "./parts"

function Section({ children }: { children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-4">{children}</section>
}

function CredentialForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valueRef = useRef("")
  const clear = () => { valueRef.current = ""; setValue("") }
  useEffect(() => () => { valueRef.current = "" }, [])
  const changeName = (next: string) => {
    // A credential value belongs only to the name it was typed for. Replacing
    // that name destroys the transient value rather than carrying it across.
    if (name && next !== name && valueRef.current) clear()
    setName(next)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!name.trim() || !valueRef.current || saving) return
    setSaving(true); setError(null)
    const result = await setCredential(name.trim(), valueRef.current)
    setSaving(false)
    if (!result.ok) { setError(result.error); return }
    clear(); setName(""); await onSaved()
  }
  return (
    <form className="flex min-w-0 flex-col gap-2" onSubmit={save}>
      {error && <Notice text={error} />}
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input className={`min-w-40 flex-1 ${NO_DRAG_REGION}`} value={name} onChange={(event) => changeName(event.target.value)} placeholder="Credential name" autoComplete="off" />
        <Input className={`min-w-40 flex-1 ${NO_DRAG_REGION}`} type="password" value={value} onChange={(event) => { valueRef.current = event.target.value; setValue(event.target.value) }} placeholder="Secret value" autoComplete="new-password" spellCheck={false} aria-label="Credential secret value" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className={NO_DRAG_REGION} type="submit" size="sm" disabled={saving || !name.trim() || !value}>
          {saving && <LoaderCircle className="animate-spin" />} Save credential
        </Button>
        <Button className={NO_DRAG_REGION} type="button" size="sm" variant="ghost" disabled={!value && !name} onClick={() => { clear(); setName(""); setError(null) }}>Cancel</Button>
      </div>
    </form>
  )
}

export function SetupView({ baseUrl, repoId, repositoryMessage, onBack, onOpenSession }: { baseUrl?: string | null; repoId?: string | null; repositoryMessage?: string | null; onBack: () => void; onOpenSession?: (sessionId: string) => void }) {
  const [sessions, setSessions] = useState<SetupSessionMeta[]>([])
  const [credentials, setCredentials] = useState<ZooCredentialMeta[]>([])
  const [message, setMessage] = useState("")
  const [starting, setStarting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = async () => {
    const [history, names] = await Promise.all([listSetupSessions(), listCredentials()])
    setSessions(history.ok ? history.sessions : []); setCredentials(names.ok ? names.credentials : [])
    const failures = [history, names].filter((result): result is { ok: false; error: string } => !result.ok).map((result) => result.error)
    setError(failures.length ? failures.join(" ") : null)
  }
  useEffect(() => { let active = true; void Promise.all([listSetupSessions(), listCredentials()]).then(([history, names]) => { if (!active) return; setSessions(history.ok ? history.sessions : []); setCredentials(names.ok ? names.credentials : []); const failures = [history, names].filter((result): result is { ok: false; error: string } => !result.ok).map((result) => result.error); setError(failures.length ? failures.join(" ") : null) }); return () => { active = false } }, [])
  const start = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim() || starting) return
    setStarting(true); setError(null)
    const result = await startSetupSession(baseUrl, repoId, message)
    setStarting(false)
    if (!result.ok) { setError(result.error); return }
    setMessage(""); onOpenSession?.(result.sessionId)
  }
  const remove = async (name: string) => {
    setDeleting(name); setError(null); const result = await deleteCredential(name); setDeleting(null)
    if (!result.ok) { setError(result.error); return }; await refresh()
  }
  const blocked = !baseUrl ? "Connect to Chunky to start a setup conversation." : !repoId ? repositoryMessage || "Select a repository or configure this area's repository before starting setup." : null
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewHeader title="Add source" subtitle="Set up evidence sources and factory workflows with Chunky" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-8">
        {error && <Notice text={error} />}
        <Section>
          <div><h2 className="font-medium text-[13px]">New setup conversation</h2><p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-muted-foreground">Describe the source or workflow. Do not paste passwords, API keys, tokens, or other secrets into chat.</p></div>
          <form className="flex min-w-0 flex-wrap gap-2" onSubmit={start}>
            <Input className={`min-w-48 flex-1 ${NO_DRAG_REGION}`} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What source or workflow do you want to set up?" />
            <Button className={NO_DRAG_REGION} type="submit" disabled={starting || !!blocked || !message.trim()}>{starting ? <LoaderCircle className="animate-spin" /> : <MessagesSquare />} Start</Button>
          </form>
          {blocked && <Notice text={blocked} tone="muted" />}
          <Button className={`${NO_DRAG_REGION} self-start`} size="sm" variant="ghost" onClick={onBack}>Back to Sources</Button>
        </Section>
        <Section>
          <div><h2 className="font-medium text-[13px]">Setup conversations</h2><p className="mt-1 text-[12px] text-muted-foreground">These are ordinary repository-bound Chunky sessions.</p></div>
          {sessions.length ? <ul className="flex min-w-0 flex-col gap-1">{sessions.map((session) => <li key={session.sessionId}><Button className={`${NO_DRAG_REGION} h-auto w-full min-w-0 justify-between gap-3 py-2`} variant="ghost" onClick={() => onOpenSession?.(session.sessionId)}><span className="min-w-0 truncate">{session.title}</span><span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(session.lastActivityAt)}</span></Button></li>)}</ul> : <EmptyState icon={<MessagesSquare className="size-5" />} title="No setup conversations" body="Start one above and it will remain an ordinary Chunky thread." />}
        </Section>
        <Section>
          <div><h2 className="flex items-center gap-2 font-medium text-[13px]"><KeyRound className="size-4" /> Named source credentials</h2><p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-muted-foreground">Values use this dedicated field and are never displayed after saving. Agents can refer only to names. Provider and Linear keys must continue using their dedicated setup flows.</p></div>
          <CredentialForm onSaved={refresh} />
          {credentials.length > 0 && <ul className="flex min-w-0 flex-wrap gap-2">{credentials.map((credential) => <li key={credential.name} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5 text-[12px]"><span className="max-w-64 truncate">{credential.name}</span><span className="text-muted-foreground">{relativeTime(credential.createdAt)}</span><Button className={NO_DRAG_REGION} size="icon-sm" variant="ghost" disabled={deleting === credential.name} aria-label={`Delete ${credential.name}`} onClick={() => void remove(credential.name)}>{deleting === credential.name ? <LoaderCircle className="animate-spin" /> : <Trash2 />}</Button></li>)}</ul>}
        </Section>
      </div>
    </div>
  )
}
