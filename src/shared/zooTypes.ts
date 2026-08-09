// An Area scopes one product inside the single zoo board. Everything else
// carries an OPTIONAL areaId: rows written before areas existed have none and
// stay visible in every area ("unassigned"), so no stored board is lost.
export type ZooArea = { id: string; name: string; repoPaths?: string[]; createdAt: number }
export type ZooAreaKind = "source" | "insight" | "idea" | "item"
export type ZooBackfillState = "idle" | "running" | "done" | "error"
export type ZooSourceKind = "linear" | "transcripts" | "repo-watch" | "x-watch"
export type ZooSource = { id: string; kind: ZooSourceKind; label: string; areaId?: string; createdAt: number; backfill: { state: ZooBackfillState; fetched: number; error?: string; completedAt?: number } }
export type ZooArtifactMeta = { id: string; sourceId: string; kind: string; externalId: string; title: string; url?: string; fetchedAt: number }
export type ZooEvidence = { artifactId: string; quote: string }
export type ZooInsight = { id: string; passId: string; title: string; summary: string; priority?: number; evidence: ZooEvidence[]; sourceLabels?: string[]; areaId?: string; createdAt: number }
export type ZooPass = { id: string; startedAt: number; status: "running" | "done" | "error"; note?: string }
export type ZooIdeaType = "close" | "investigate" | "build" | "needs-detail"
export type ZooIdeaStatus = "proposed" | "promoted" | "dismissed"
export type ZooJamSession = { sessionId: string; createdAt: number; outcomeAt?: number }
export type ZooIdeaDecision = { at: number; actor: "user" | "agent"; note: string; sessionId?: string }
export type ZooIdea = { id: string; type: ZooIdeaType; title: string; rationale: string; status: ZooIdeaStatus; insightIds: string[]; jamSessions?: ZooJamSession[]; decisions?: ZooIdeaDecision[]; areaId?: string; createdAt: number; itemId?: string; dismissReason?: string }
export type ZooItemStage = "research" | "decision" | "building" | "review" | "shipped" | "dropped"
export type ZooDecision = { at: number; actor: "user" | "agent"; note: string }
export type ZooItem = { id: string; ideaId: string; title: string; stage: ZooItemStage; sessionIds: string[]; jamSessions?: ZooJamSession[]; decisions: ZooDecision[]; areaId?: string; createdAt: number; updatedAt: number }

/** A watched competitor repository. The watch owns the check state; the source
 *  row it points at owns the area and the artifacts the check produced. */
export type ZooWatchStatus = "ok" | "skipped" | "error"
export type ZooRepoWatch = { id: string; sourceId: string; owner: string; name: string; label: string; areaId?: string; lastCheckAt?: number; lastStatus?: ZooWatchStatus; lastNote?: string; lastArtifactAt?: number; lastExtractAt?: number; createdAt: number }
/** One watch's result from a check pass. */
export type ZooWatchResult = { watchId: string; label: string; status: ZooWatchStatus; added: number; note?: string }

/** An X account collected through a repository-less, session-pinned Grok run. */
export type ZooXWatch = { id: string; sourceId: string; handle: string; label: string; areaId?: string; lastSuccessAt?: number; lastAttemptAt?: number; lastStatus?: ZooWatchStatus; lastNote?: string; lastArtifactAt?: number; lastExtractAt?: number; createdAt: number }
export type ZooXWatchResult = { watchId: string; label: string; status: "ok" | "error"; added: number; note?: string }

/** Local index of ordinary Chunky sessions started from Add source. */
export type SetupSessionMeta = { sessionId: string; title: string; createdAt: number; lastActivityAt: number }
/** Renderer-visible credential shape. Values deliberately have no public type. */
export type ZooCredentialMeta = { name: string; createdAt: number }
