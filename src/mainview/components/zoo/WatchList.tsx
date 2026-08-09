// Competitor watch, in the Sources view.
//
// Add a repository, see what the last check found, check one now, or set the
// hour the daily check runs at. Every GitHub call happens in the Bun process —
// this component only calls lib/zoo.ts and lib/zooWatch.ts.

import { Binoculars, Github, LoaderCircle, RefreshCw, Trash2 } from "lucide-react"
import { useState, type FormEvent } from "react"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/format"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { openExternal } from "~/lib/openExternal"
import { zooAddRepoWatch, zooRemoveRepoWatch, zooSetWatchSchedule, type ZooArea, type ZooRepoWatch } from "~/lib/zoo"
import { areaName, type AreaSelection } from "~/lib/zooAreas"
import { checkAndSynthesize, needsSynthesis, summarizeCheck, synthesizePending, watchStatusLabel, type WatchRunPhase } from "~/lib/zooWatch"
import { AreaAssignMenu, AreaBadge } from "./AreaSwitcher"
import { Select } from "../settings/common"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Notice } from "./parts"

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

const PHASE_LABEL: Record<WatchRunPhase, string> = {
  checking: "Checking GitHub",
  exporting: "Bundling what they shipped",
  starting: "Starting a session",
  thinking: "Reading it",
  recording: "Recording signals",
}

function statusTone(watch: ZooRepoWatch): string {
  if (watch.lastStatus === "error") return "text-destructive"
  if (watch.lastStatus === "skipped") return "text-amber-600 dark:text-amber-400"
  return "text-muted-foreground"
}

export function WatchList({
  watches,
  areas,
  hour,
  lastRunAt,
  areaId,
  baseUrl,
  onRefresh,
  onAssignArea,
}: {
  watches: ZooRepoWatch[]
  areas: ZooArea[]
  /** Local hour the daily check runs at. */
  hour: number
  lastRunAt: number | null
  /** Area new watches join; null = unassigned. */
  areaId: AreaSelection
  baseUrl?: string | null
  onRefresh: () => Promise<void>
  onAssignArea: (sourceId: string, areaId: string | null) => void
}) {
  const [repo, setRepo] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [phase, setPhase] = useState<WatchRunPhase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = repo.trim()
    if (!value || busy) return
    setBusy("add")
    setError(null)
    const result = await zooAddRepoWatch(value, areaId)
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setRepo("")
    setNote(`Watching ${result.watch.label}. The first check records a baseline, then reports changes.`)
    await onRefresh()
  }

  const remove = async (watch: ZooRepoWatch) => {
    if (busy) return
    setBusy(watch.id)
    setError(null)
    const result = await zooRemoveRepoWatch(watch.id)
    setBusy(null)
    if (!result.ok) setError(result.error)
    else setNote(`Stopped watching ${watch.label}. What it already taught us stays on the board.`)
    await onRefresh()
  }

  /** Check one watch and synthesize whatever it found, in one gesture. */
  const check = async (watch: ZooRepoWatch | null) => {
    if (busy) return
    setBusy(watch?.id ?? "all")
    setError(null)
    setNote(null)
    const result = await checkAndSynthesize(watch, { baseUrl, onPhase: setPhase })
    setPhase(null)
    setBusy(null)
    if (result.error) setError(result.error)
    const summary = summarizeCheck(result.results)
    setNote(
      result.insightCount === null
        ? summary
        : `${summary} · ${result.insightCount} signal${result.insightCount === 1 ? "" : "s"} recorded`,
    )
    await onRefresh()
  }

  const synthesize = async (watch: ZooRepoWatch) => {
    if (busy) return
    setBusy(watch.id)
    setError(null)
    const result = await synthesizePending(watch, { baseUrl, onPhase: setPhase })
    setPhase(null)
    setBusy(null)
    if (result.error) setError(result.error)
    else setNote(`${result.insightCount ?? 0} signal${result.insightCount === 1 ? "" : "s"} recorded from ${watch.label}.`)
    await onRefresh()
  }

  const changeHour = async (next: number) => {
    setError(null)
    const result = await zooSetWatchSchedule(next)
    if (!result.ok) setError(result.error)
    await onRefresh()
  }

  return (
    <section className={cn(NO_DRAG_REGION, "@container/watch flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/60 p-3")}>
      <div className="flex min-w-0 flex-col gap-2 @min-[32rem]/watch:flex-row @min-[32rem]/watch:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <Binoculars className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 font-medium text-[13px] text-foreground">Competitor watch</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[32rem]/watch:ml-auto">
        <label className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          Daily at
          <Select
            value={String(hour)}
            onChange={(value) => void changeHour(Number(value))}
            className="h-7 w-[5.25rem] text-[11.5px]"
          >
            {HOURS.map((value) => (
              <option key={value} value={value}>
                {String(value).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || watches.length === 0}
          onClick={() => void check(null)}
        >
          {busy === "all" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Check all
        </Button>
        </div>
      </div>

      <p className="text-[11.5px] text-muted-foreground">
        Releases, tags, merged PRs and changelog commits from repositories you care about — checked in the
        background and turned into Inbox signals.
        {lastRunAt ? ` Last run ${relativeTime(lastRunAt)}.` : " Not run yet."}
      </p>

      {watches.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {watches.map((watch) => {
            const pending = needsSynthesis(watch)
            const area = areaName(areas, watch.areaId)
            return (
              <li
                key={watch.id}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
              >
                <div className="flex min-w-0 flex-col gap-2 @min-[32rem]/watch:flex-row @min-[32rem]/watch:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Github className="size-3.5 shrink-0 text-muted-foreground" />
                    <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-0 text-left font-mono text-[12px] text-foreground hover:underline"
                    title={`Open ${watch.label} on GitHub`}
                    onClick={() => openExternal(`https://github.com/${watch.owner}/${watch.name}`)}
                  >
                    <span className="min-w-0 break-all">{watch.label}</span>
                    </Button>
                    {area && <AreaBadge name={area} />}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <AreaAssignMenu
                    areas={areas}
                    areaId={watch.areaId}
                    disabled={busy !== null}
                    onAssign={(next) => onAssignArea(watch.sourceId, next)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void check(watch)}
                    title="Check this repository now"
                  >
                    {busy === watch.id ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                    Check now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Stop watching ${watch.label}`}
                    disabled={busy !== null}
                    onClick={() => void remove(watch)}
                  >
                    <Trash2 />
                  </Button>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={cn("min-w-0 break-words text-[11.5px]", statusTone(watch))}>
                    {busy === watch.id && phase ? PHASE_LABEL[phase] : watchStatusLabel(watch)}
                  </span>
                  {pending && busy !== watch.id && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void synthesize(watch)}>
                      Synthesize new activity
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <form onSubmit={add} className="flex min-w-0 flex-col gap-1.5 @min-[24rem]/watch:flex-row @min-[24rem]/watch:items-center">
        <Input
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/name — e.g. sst/opencode"
          spellCheck={false}
          autoComplete="off"
          aria-label="Repository to watch"
          className="w-full min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={busy !== null || !repo.trim()}>
          {busy === "add" ? <LoaderCircle className="animate-spin" /> : null}
          Watch
        </Button>
      </form>

      {error && <Notice text={error} />}
      {note && !error && <Notice text={note} tone="muted" />}
      {!baseUrl && watches.length > 0 && (
        <Notice text="Checks still run in the background; turning what they find into signals needs a connected Chunky server." tone="muted" />
      )}
    </section>
  )
}
