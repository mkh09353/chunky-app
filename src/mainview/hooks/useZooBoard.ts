// One live read of the product-factory board for the whole Zoo workspace.
//
// Every view (Inbox, Board, Sources) and the detail pane share this snapshot, so
// a verdict taken in one place repaints all of them. All access goes through
// lib/zoo.ts — the components never touch the RPC bridge.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  zooAvailable,
  zooListAreas,
  zooListIdeas,
  zooListInsights,
  zooListItems,
  zooListRepoWatches,
  zooStatus,
  type ZooArea,
  type ZooRepoWatch,
  type ZooIdea,
  type ZooInsight,
  type ZooItem,
  type ZooStatus,
} from "~/lib/zoo"

/** Backfills are the only thing that changes without us asking. */
const POLL_MS = 2000

export type ZooBoard = {
  /** False outside the desktop app: the store lives in the Bun process. */
  available: boolean
  status: ZooStatus | null
  /** Products sharing this one board. Empty is normal, not an error state. */
  areas: ZooArea[]
  /** Watched competitor repositories, plus the daily check's schedule. */
  watches: ZooRepoWatch[]
  watchHour: number
  watchLastRunAt: number | null
  insights: ZooInsight[]
  ideas: ZooIdea[]
  items: ZooItem[]
  error: string | null
  loading: boolean
  refresh: () => Promise<void>
}

export function useZooBoard(): ZooBoard {
  const [available] = useState(zooAvailable)
  const [status, setStatus] = useState<ZooStatus | null>(null)
  const [areas, setAreas] = useState<ZooArea[]>([])
  const [watches, setWatches] = useState<ZooRepoWatch[]>([])
  const [watchHour, setWatchHour] = useState(8)
  const [watchLastRunAt, setWatchLastRunAt] = useState<number | null>(null)
  const [insights, setInsights] = useState<ZooInsight[]>([])
  const [ideas, setIdeas] = useState<ZooIdea[]>([])
  const [items, setItems] = useState<ZooItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(available)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!zooAvailable()) {
      setLoading(false)
      return
    }
    const [next, insightList, ideaList, itemList, areaList, watchList] = await Promise.all([
      zooStatus(),
      zooListInsights(),
      zooListIdeas(),
      zooListItems(),
      zooListAreas(),
      zooListRepoWatches(),
    ])
    if (!alive.current) return
    if (next.ok) {
      setStatus({
        sources: next.sources,
        artifactCount: next.artifactCount,
        insightCount: next.insightCount,
        ideaCount: next.ideaCount,
        itemCount: next.itemCount,
        passes: next.passes,
      })
      setError(null)
    } else if (!next.unavailable) {
      setError(next.error)
    }
    if (insightList.ok) setInsights(insightList.insights)
    if (ideaList.ok) setIdeas(ideaList.ideas)
    if (itemList.ok) setItems(itemList.items)
    if (areaList.ok) setAreas(areaList.areas)
    if (watchList.ok) {
      setWatches(watchList.watches)
      setWatchHour(watchList.hour)
      setWatchLastRunAt(watchList.lastRunAt)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!available) return
    void refresh()
  }, [available, refresh])

  const backfilling = !!status?.sources.some((source) => source.backfill.state === "running")
  useEffect(() => {
    if (!available || !backfilling) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [available, backfilling, refresh])

  return { available, status, areas, watches, watchHour, watchLastRunAt, insights, ideas, items, error, loading, refresh }
}
