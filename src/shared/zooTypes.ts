// An Area scopes one product inside the single zoo board. Everything else
// carries an OPTIONAL areaId: rows written before areas existed have none and
// stay visible in every area ("unassigned"), so no stored board is lost.
export type ZooArea = { id: string; name: string; repoPaths?: string[]; createdAt: number }
export type ZooAreaKind = "source" | "insight" | "idea" | "item"
export type ZooBackfillState = "idle" | "running" | "done" | "error"
export type ZooSource = { id: string; kind: "linear" | "transcripts"; label: string; areaId?: string; createdAt: number; backfill: { state: ZooBackfillState; fetched: number; error?: string; completedAt?: number } }
export type ZooArtifactMeta = { id: string; sourceId: string; kind: string; externalId: string; title: string; url?: string; fetchedAt: number }
export type ZooEvidence = { artifactId: string; quote: string }
export type ZooInsight = { id: string; passId: string; title: string; summary: string; priority?: number; evidence: ZooEvidence[]; areaId?: string; createdAt: number }
export type ZooPass = { id: string; startedAt: number; status: "running" | "done" | "error"; note?: string }
export type ZooIdeaType = "close" | "investigate" | "build" | "needs-detail"
export type ZooIdeaStatus = "proposed" | "promoted" | "dismissed"
export type ZooIdea = { id: string; type: ZooIdeaType; title: string; rationale: string; status: ZooIdeaStatus; insightIds: string[]; areaId?: string; createdAt: number; itemId?: string; dismissReason?: string }
export type ZooItemStage = "research" | "decision" | "building" | "review" | "shipped" | "dropped"
export type ZooDecision = { at: number; actor: "user" | "agent"; note: string }
export type ZooItem = { id: string; ideaId: string; title: string; stage: ZooItemStage; sessionIds: string[]; decisions: ZooDecision[]; areaId?: string; createdAt: number; updatedAt: number }
