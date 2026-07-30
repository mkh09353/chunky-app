export type ZooBackfillState = "idle" | "running" | "done" | "error"
export type ZooSource = { id: string; kind: "linear"; label: string; createdAt: number; backfill: { state: ZooBackfillState; fetched: number; error?: string; completedAt?: number } }
export type ZooArtifactMeta = { id: string; sourceId: string; kind: string; externalId: string; title: string; url?: string; fetchedAt: number }
export type ZooEvidence = { artifactId: string; quote: string }
export type ZooInsight = { id: string; passId: string; title: string; summary: string; priority?: number; evidence: ZooEvidence[]; createdAt: number }
export type ZooPass = { id: string; startedAt: number; status: "running" | "done" | "error"; note?: string }
