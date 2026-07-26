import {
  ArrowUp,
  Check,
  ChevronDown,
  Cpu,
  File,
  ListPlus,
  Loader2,
  Paperclip,
  Square,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FileSearchItem } from "@chunky/protocol"
import type { Model } from "~/lib/mock"
import { MODELS } from "~/lib/mock"
import { cn } from "~/lib/cn"
import { providerLabel } from "~/lib/api"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { Kbd } from "./ui/kbd"
import { Textarea } from "./ui/textarea"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** Stable-ish provider section order for the live picker. */
const PROVIDER_ORDER = ["zen", "grok", "codex", "anthropic"]

function providerSortKey(vendor: string): string {
  const i = PROVIDER_ORDER.indexOf(vendor.toLowerCase())
  return i >= 0 ? `${i}-${vendor}` : `9-${vendor}`
}

export function Composer({
  model,
  models = MODELS,
  onModelChange,
  onRefreshModels,
  onSend,
  onSearchFiles,
  streaming,
  onStop,
  disabled = false,
  contextMeter,
  cacheGuard,
  onCacheConfirm,
  onCacheCancel,
}: {
  model: Model
  models?: Model[]
  /** Must resolve only after the server confirms (live) or local apply (demo). */
  onModelChange: (m: Model) => void | Promise<void>
  /** Re-fetch current selection + catalogs when the menu opens (live). */
  onRefreshModels?: () => void | Promise<void>
  onSend: (text: string, opts?: { delivery?: "interject"; images?: { base64: string; mediaType: string }[] }) => void
  onSearchFiles?: (query: string) => Promise<FileSearchItem[]>
  streaming: boolean
  onStop: () => void
  disabled?: boolean
  /** Optional context-window meter rendered in the composer footer. */
  contextMeter?: React.ReactNode
  cacheGuard?: { approxTokens: number; reason: string } | null
  onCacheConfirm?: () => void
  onCacheCancel?: () => void
}) {
  const [value, setValue] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [images, setImages] = useState<{ base64: string; mediaType: string; name: string }[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionItems, setMentionItems] = useState<FileSearchItem[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const switchGen = useRef(0)

  const busy = switchingId !== null

  const groups = useMemo(() => {
    const map = new Map<string, Model[]>()
    for (const m of models) {
      const key = m.vendor || "other"
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => providerSortKey(a).localeCompare(providerSortKey(b)))
  }, [models])

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  const submit = (delivery?: "interject") => {
    const text = value.trim()
    // While the agent is running, submitting ENQUEUES (App picks delivery); the
    // parent decides queue-vs-send from `streaming`, so we never hard-block here.
    if ((!text && images.length === 0) || disabled) return
    onSend(text, { delivery, images: images.map(({ base64, mediaType }) => ({ base64, mediaType })) })
    setValue("")
    setImages([])
    if (ref.current) ref.current.style.height = "auto"
  }

  useEffect(() => {
    if (!mentionOpen || !onSearchFiles) return
    const timer = window.setTimeout(() => {
      void onSearchFiles(mentionQuery).then((items) => {
        setMentionItems(items)
        setMentionIndex(0)
      }).catch(() => setMentionItems([]))
    }, 100)
    return () => clearTimeout(timer)
  }, [mentionOpen, mentionQuery, onSearchFiles])

  const updateMentions = (next: string, cursor: number) => {
    const before = next.slice(0, cursor)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
    setMentionOpen(!!match && !!onSearchFiles)
    setMentionQuery(match?.[1] ?? "")
  }

  const insertMention = (item: FileSearchItem) => {
    const el = ref.current
    const cursor = el?.selectionStart ?? value.length
    const before = value.slice(0, cursor)
    const start = before.lastIndexOf("@")
    const next = `${value.slice(0, start)}@${item.path} ${value.slice(cursor)}`
    setValue(next)
    setMentionOpen(false)
    requestAnimationFrame(() => {
      el?.focus()
      const position = start + item.path.length + 2
      el?.setSelectionRange(position, position)
    })
  }

  const addImages = (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result)
        const base64 = result.split(",")[1]
        if (base64) setImages((old) => [...old, { base64, mediaType: file.type, name: file.name }])
      }
      reader.readAsDataURL(file)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (busy && !open) {
      // Keep the menu open while a switch is in flight so the user sees status.
      return
    }
    setMenuOpen(open)
    if (open) {
      setPickerError(null)
      if (onRefreshModels) {
        setRefreshing(true)
        void Promise.resolve(onRefreshModels())
          .catch((err) => {
            setPickerError((err as Error).message || "Couldn't refresh models")
          })
          .finally(() => setRefreshing(false))
      }
    }
  }

  const pick = async (m: Model) => {
    if (busy) return
    if (m.ready === false) return
    if (m.id === model.id) {
      setMenuOpen(false)
      return
    }
    const gen = ++switchGen.current
    setSwitchingId(m.id)
    setPickerError(null)
    try {
      await onModelChange(m)
      if (gen !== switchGen.current) return
      setMenuOpen(false)
    } catch (err) {
      if (gen !== switchGen.current) return
      setPickerError((err as Error).message || "Couldn't switch model")
    } finally {
      if (gen === switchGen.current) setSwitchingId(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {/* Todos + queued messages render above the composer via TodosPanel /
          QueueChips (see App.tsx) so both surfaces stay in one place. */}
      {cacheGuard && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200"><span>This will resend ~{cacheGuard.approxTokens.toLocaleString()} tokens of cold context.</span><button type="button" onClick={onCacheConfirm} className="font-semibold text-primary hover:underline">Send anyway</button><button type="button" onClick={onCacheCancel} className="font-medium hover:underline">Cancel</button></div>}
      <div className="rounded-[22px] border border-border bg-card/80 p-2 shadow-panel backdrop-blur-xl transition-colors focus-within:border-ring/60">
        {images.length > 0 && <div className="flex flex-wrap gap-1 px-2 pt-1">{images.map((image, i) => <span key={`${image.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]"><File className="size-3" />{image.name}<button type="button" onClick={() => setImages((old) => old.filter((_, index) => index !== i))}><X className="size-3" /></button></span>)}</div>}
        <Textarea
          ref={ref}
          value={value}
          rows={1}
          disabled={disabled && !streaming}
          placeholder={
            disabled && !streaming
              ? "Connect to the server to send a message…"
              : "Ask Chunky to build, explain, or fix something…"
          }
          className="max-h-[220px] min-h-[44px] px-3 py-2.5 text-[14px] leading-relaxed"
          onChange={(e) => {
            setValue(e.target.value)
            grow(e.target)
            updateMentions(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((old) => Math.max(0, Math.min(mentionItems.length - 1, old + (e.key === "ArrowDown" ? 1 : -1)))) }
              else if ((e.key === "Enter" || e.key === "Tab") && mentionItems[mentionIndex]) { e.preventDefault(); insertMention(mentionItems[mentionIndex]!) }
              else if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false) }
              return
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit(e.altKey ? "interject" : undefined)
            }
          }}
        />
        {mentionOpen && <div className="mx-2 mb-1 overflow-hidden rounded-lg border border-border bg-popover shadow-panel">{mentionItems.length ? mentionItems.map((item, i) => <button type="button" key={item.path} onMouseDown={(e) => { e.preventDefault(); insertMention(item) }} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-accent", i === mentionIndex && "bg-accent")}><File className="size-3 text-primary" /><span className="truncate">{item.path}</span><span className="ml-auto text-muted-foreground">{item.kind}</span></button>) : <div className="px-3 py-2 text-[12px] text-muted-foreground">No matching files</div>}</div>}

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => fileRef.current?.click()} />}>
                <Paperclip />
              </TooltipTrigger>
              <TooltipPopup>Attach files</TooltipPopup>
            </Tooltip>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addImages(e.target.files); e.currentTarget.value = "" }} />

            <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange}>
              <DropdownMenuTrigger
                disabled={disabled && !streaming}
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-w-[min(100%,18rem)] gap-1.5 text-muted-foreground"
                  />
                }
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <Cpu className="size-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate font-medium text-foreground">
                  {busy ? "Switching…" : model.name}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="flex max-h-80 min-w-72 flex-col overflow-hidden p-0"
              >
                <div className="flex items-center justify-between gap-2 border-border/70 border-b px-2.5 py-1.5">
                  <DropdownMenuLabel className="p-0">Model</DropdownMenuLabel>
                  {refreshing && (
                    <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Refreshing
                    </span>
                  )}
                </div>

                <div className="overflow-y-auto p-1">
                  {models.length === 0 ? (
                    <DropdownMenuItem disabled>
                      {refreshing ? "Loading models…" : "No models available"}
                    </DropdownMenuItem>
                  ) : (
                    groups.map(([vendor, rows], gi) => (
                      <div key={vendor}>
                        {gi > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="flex items-center justify-between gap-2">
                          <span>{providerLabel(vendor)}</span>
                          {rows.some((r) => r.ready === false) &&
                            rows.every((r) => r.ready === false) && (
                              <span className="font-normal text-[10px] text-amber-600 dark:text-amber-400">
                                not ready
                              </span>
                            )}
                        </DropdownMenuLabel>
                        {rows.map((m) => {
                          const selected = m.id === model.id
                          const notReady = m.ready === false
                          const rowBusy = switchingId === m.id
                          return (
                            <DropdownMenuItem
                              key={m.id}
                              disabled={notReady || (busy && !rowBusy)}
                              closeOnClick={false}
                              onClick={() => void pick(m)}
                              className={cn(selected && "bg-accent/60")}
                            >
                              <span className="flex size-4 shrink-0 items-center justify-center">
                                {rowBusy ? (
                                  <Loader2 className="size-3.5 animate-spin text-primary" />
                                ) : selected ? (
                                  <Check className="size-3.5 text-primary" />
                                ) : (
                                  <Cpu className="size-3.5 opacity-50" />
                                )}
                              </span>
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate font-medium text-[13px] text-foreground">
                                  {m.name}
                                </span>
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {notReady ? "not logged in" : m.note || m.vendor}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          )
                        })}
                      </div>
                    ))
                  )}
                </div>

                {pickerError && (
                  <div className="border-destructive/25 border-t bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                    {pickerError}
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {contextMeter}
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
              <Kbd>⏎</Kbd> {streaming ? "queue" : "send"}
              {streaming && <><span>·</span><Kbd>⌥⏎</Kbd> interject</>}
              <Kbd>⇧⏎</Kbd> newline
            </span>
            {streaming && (
              <Button size="icon" variant="secondary" onClick={onStop} aria-label="Stop">
                <Square className="size-3.5 fill-current" />
              </Button>
            )}
            <Button
              size="icon"
              onClick={() => submit()}
              disabled={(!value.trim() && images.length === 0) || disabled}
              aria-label={streaming ? "Queue message" : "Send"}
              variant={streaming ? "secondary" : "default"}
              className="rounded-full"
              title={streaming ? "Queue message (agent is running)" : "Send"}
            >
              {streaming ? <ListPlus /> : <ArrowUp />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
