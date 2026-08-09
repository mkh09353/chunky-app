// The right-hand detail pane: everything behind the card the user selected —
// full evidence, the artifacts the quotes came from, and the decision log.
//
// Reading an artifact is the one server round trip this pane makes, and it goes
// through lib/zoo.ts like everything else.

import { ExternalLink, LoaderCircle, X } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/format"
import { openExternal } from "~/lib/openExternal"
import { zooGetArtifact, type ZooArea, type ZooAreaKind, type ZooArtifactDetail } from "~/lib/zoo"
import type { InboxEntry } from "~/lib/zooInbox"
import { latestSessionId } from "~/lib/zooItemFlow"
import { AreaAssignMenu } from "./AreaSwitcher"
import { Button } from "../ui/button"
import {
  Badge,
  EvidenceQuote,
  IDEA_TYPE_LABEL,
  IDEA_TYPE_TONE,
  Notice,
  priorityTone,
  STAGE_LABEL,
  STAGE_TONE,
} from "./parts"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h4 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">{title}</h4>
      {children}
    </section>
  )
}

export function DetailPane({
  entry,
  areas,
  onAssignArea,
  areaBusy = false,
  onClose,
  onOpenSession,
}: {
  entry: InboxEntry
  areas: ZooArea[]
  /** Reassign this row to another area (or to none). */
  onAssignArea?: (kind: ZooAreaKind, id: string, areaId: string | null) => void
  areaBusy?: boolean
  onClose: () => void
  onOpenSession?: (sessionId: string) => void
}) {
  const [artifact, setArtifact] = useState<ZooArtifactDetail | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)

  // A different card means a different set of quotes; drop the open artifact.
  useEffect(() => {
    setArtifact(null)
    setArtifactError(null)
    setArtifactLoading(false)
  }, [entry.id])

  const openArtifact = async (id: string) => {
    setArtifactLoading(true)
    setArtifactError(null)
    setArtifact(null)
    const result = await zooGetArtifact(id)
    setArtifactLoading(false)
    if (result.ok) setArtifact(result.artifact)
    else setArtifactError(result.error)
  }

  const item = entry.item
  const idea = entry.idea
  const sessionId = item ? latestSessionId(item) : null

  return (
    <aside
      aria-label="Detail"
      className="flex min-h-0 w-[clamp(16rem,32vw,26rem)] shrink-0 flex-col border-border/70 border-l bg-background/60"
    >
      <header className="flex min-h-[52px] shrink-0 items-start gap-2 border-border/70 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 whitespace-pre-wrap break-words font-medium text-[13.5px] text-foreground leading-snug">
            {entry.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {item && <Badge className={STAGE_TONE[item.stage]}>{STAGE_LABEL[item.stage]}</Badge>}
            {idea && <Badge className={IDEA_TYPE_TONE[idea.type]}>{IDEA_TYPE_LABEL[idea.type]}</Badge>}
            <span className="text-[11px] text-muted-foreground">{relativeTime(entry.at)}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close detail" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {(entry.item || entry.idea) && (
          <Section title="Area">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <AreaAssignMenu
                areas={areas}
                areaId={entry.areaId}
                disabled={areaBusy || !onAssignArea}
                onAssign={(areaId) => {
                  // An idea and the item it became always move together, so
                  // whichever half is on screen can carry the pair.
                  if (entry.item) onAssignArea?.("item", entry.item.id, areaId)
                  else if (entry.idea) onAssignArea?.("idea", entry.idea.id, areaId)
                }}
              />
              {!entry.areaId && (
                <span className="min-w-0 break-words text-[11.5px] text-muted-foreground">
                  Unassigned — visible in every area.
                </span>
              )}
            </div>
          </Section>
        )}

        <Section title="Why it's here">
          <p className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] text-muted-foreground leading-relaxed">
            {entry.why}
          </p>
        </Section>

        {idea && (
          <Section title="Rationale">
            <p className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] text-foreground leading-relaxed">
              {idea.rationale}
            </p>
          </Section>
        )}

        <Section title={`Evidence · ${entry.insights.length}`}>
          {entry.insights.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No insights are attached to this one.</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-3">
              {entry.insights.map((insight) => (
                <li key={insight.id} className="min-w-0 border-border/60 border-l-2 pl-2.5">
                  <div className="flex min-w-0 items-start gap-2">
                    <p className="min-w-0 flex-1 break-words font-medium text-[12.5px] text-foreground">
                      {insight.title}
                    </p>
                    {insight.priority !== undefined && (
                      <Badge className={priorityTone(insight.priority)}>P{insight.priority}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 min-w-0 whitespace-pre-wrap break-words text-[12px] text-muted-foreground leading-relaxed">
                    {insight.summary}
                  </p>
                  <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
                    {insight.evidence.map((cite, index) => (
                      <li key={`${cite.artifactId}-${index}`} className="min-w-0">
                        <EvidenceQuote cite={cite} onOpen={(id) => void openArtifact(id)} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(artifactLoading || artifactError || artifact) && (
          <Section title="Artifact">
            {artifactLoading && (
              <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                Loading the source…
              </p>
            )}
            {artifactError && <Notice text={artifactError} />}
            {artifact && (
              <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-muted/20 p-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono">{artifact.externalId}</span>
                  <span>{artifact.kind}</span>
                  <span>{relativeTime(artifact.fetchedAt)}</span>
                  {artifact.url && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      onClick={() => openExternal(String(artifact.url))}
                    >
                      <ExternalLink />
                      Open source
                    </Button>
                  )}
                </div>
                <p className="min-w-0 break-words font-medium text-[12.5px] text-foreground">
                  {artifact.title}
                </p>
                <pre className="max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-foreground leading-relaxed">
                  {artifact.content}
                </pre>
              </div>
            )}
          </Section>
        )}

        {item && (
          <Section title={`Decision log · ${item.decisions.length}`}>
            {item.decisions.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Nothing has been decided yet.</p>
            ) : (
              <ol className="flex min-w-0 flex-col gap-2">
                {[...item.decisions]
                  .sort((a, b) => b.at - a.at)
                  .map((decision, index) => (
                    <li key={`${decision.at}-${index}`} className="flex min-w-0 gap-2">
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          decision.actor === "user" ? "bg-primary" : "bg-muted-foreground/50",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] text-foreground leading-relaxed">
                          {decision.note}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {decision.actor === "user" ? "You" : "The factory"} ·{" "}
                          {relativeTime(decision.at)}
                        </p>
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </Section>
        )}

        {item && item.sessionIds.length > 0 && (
          <Section title={`Sessions · ${item.sessionIds.length}`}>
            <div className="flex flex-wrap gap-1.5">
              {item.sessionIds.map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant={id === sessionId ? "outline" : "ghost"}
                  disabled={!onOpenSession}
                  onClick={() => onOpenSession?.(id)}
                >
                  <span className="max-w-40 truncate font-mono text-[11px]">{id}</span>
                </Button>
              ))}
            </div>
          </Section>
        )}
      </div>
    </aside>
  )
}
