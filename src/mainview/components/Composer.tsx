import {
  ArrowUp,
  Check,
  ChevronDown,
  Cpu,
  File,
  ListPlus,
  Loader2,
  ChevronRight,
  Paperclip,
  Square,
  X,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FileSearchItem } from "@chunky/protocol"
import type { Model } from "~/lib/mock"
import { MODELS } from "~/lib/mock"
import { cn } from "~/lib/cn"
import { providerLabel } from "~/lib/api"
import { filterCommands, type SlashCommand } from "~/lib/slashCommands"
import { modeEmoji } from "~/lib/modes"
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

/** ~7MB of base64, mirroring the TUI's clipboard grab (packages/tui/src/
 *  clipboardImage.ts). The server enforces no cap of its own, and we have no
 *  image library to resize with, so oversized images are skipped — loudly. */
const MAX_IMAGE_BASE64_LENGTH = 7_000_000

/** File extension for a synthesized name, derived from the MIME subtype
 *  (`image/svg+xml` -> `svg`, `image/jpeg` -> `jpg`). */
function extensionFor(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split("+")[0]?.toLowerCase()
  if (!subtype) return "png"
  return subtype === "jpeg" ? "jpg" : subtype
}

/** An image attachment staged in the composer. `dataUrl` is kept only for the
 *  local thumbnail; `base64`/`mediaType` are what ride the send. */
interface StagedImage {
  id: string
  base64: string
  mediaType: string
  name: string
  dataUrl: string
}

/** A saved mode as the selector lists it: the server's name plus the compact
 *  "what it switches you to" line the caller already knows how to word. */
export interface ModeOption {
  name: string
  detail?: string
}

export function Composer({
  model,
  models = MODELS,
  modes = [],
  activeMode = null,
  onSelectMode,
  onModelChange,
  onRefreshModels,
  onSend,
  onSearchFiles,
  commands = [],
  openModelPickerSignal,
  streaming,
  onStop,
  disabled = false,
  contextMeter,
  status,
  cacheGuard,
  onCacheConfirm,
  onCacheCancel,
}: {
  model: Model
  models?: Model[]
  /** Saved modes for the selector's Modes section; empty hides the section. */
  modes?: ModeOption[]
  /** Name of the mode currently in effect — the button's label, when set. */
  activeMode?: string | null
  /** Apply a saved mode (the same path `/mode <name>` / `/<name>` takes). */
  onSelectMode?: (name: string) => void | Promise<void>
  /** Must resolve only after the server confirms (live) or local apply (demo). */
  onModelChange: (m: Model) => void | Promise<void>
  /** Re-fetch current selection + catalogs when the menu opens (live). */
  onRefreshModels?: () => void | Promise<void>
  onSend: (text: string, opts?: { delivery?: "interject"; images?: { base64: string; mediaType: string }[] }) => void
  onSearchFiles?: (query: string) => Promise<FileSearchItem[]>
  /** Slash commands (built-ins + saved-mode aliases) for the `/` popup. */
  commands?: SlashCommand[]
  /** Bump to open the model picker from outside (e.g. the `/model` command). */
  openModelPickerSignal?: number
  streaming: boolean
  onStop: () => void
  disabled?: boolean
  /** Optional context-window meter rendered in the composer footer. */
  contextMeter?: React.ReactNode
  /** TUI-parity status rule (executor + sidekick/advisor/goal/incognito chips).
   *  Rendered INLINE, right of the model selector — one action row, not two. */
  status?: React.ReactNode
  cacheGuard?: { approxTokens: number; reason: string } | null
  onCacheConfirm?: () => void
  onCacheCancel?: () => void
}) {
  const [value, setValue] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [images, setImages] = useState<StagedImage[]>([])
  /** Transient "we skipped something" line above the chips (oversized/unreadable
   *  images). Cleared on a timer so it never becomes permanent chrome. */
  const [imageNotice, setImageNotice] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionItems, setMentionItems] = useState<FileSearchItem[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const switchGen = useRef(0)
  /** Per-composer-session counters: attachment keys, and the "Pasted image N"
   *  numbering (which keeps climbing across sends, like a scratch pad). */
  const imageSeq = useRef(0)
  const pasteSeq = useRef(0)
  /** dragenter/dragleave fire for every child too; count depth so moving over
   *  the textarea or a chip doesn't flicker the highlight off. */
  const dragDepth = useRef(0)

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

  // Slash popup: only while the whole input is one `/token` (never mid-message),
  // matching the TUI's `value.startsWith("/") && !value.includes(" ")`.
  const slashActive = !slashDismissed && value.startsWith("/") && !value.includes(" ")
  const slashMatches = useMemo(
    () => (slashActive ? filterCommands(commands, value) : []),
    [slashActive, commands, value],
  )
  const slashOpen = slashActive && slashMatches.length > 0

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  /** Nothing to send (and the composer isn't blocked) — shared by every button. */
  const nothingToSend = (!value.trim() && images.length === 0) || disabled

  const submit = (delivery?: "interject") => {
    const text = value.trim()
    // While the agent is running, submitting ENQUEUES (App picks delivery); the
    // parent decides queue-vs-send from `streaming`, so we never hard-block here.
    if ((!text && images.length === 0) || disabled) return
    onSend(text, { delivery, images: images.map(({ base64, mediaType }) => ({ base64, mediaType })) })
    setValue("")
    setImages([])
    setImageNotice(null)
    setSlashDismissed(false)
    if (ref.current) ref.current.style.height = "auto"
  }

  /** Menu pick: bare commands run now, argument-taking ones just complete. */
  const runCommand = (cmd: SlashCommand) => {
    setSlashIndex(0)
    setSlashDismissed(false)
    setValue("")
    if (ref.current) ref.current.style.height = "auto"
    onSend(cmd.name)
  }

  const completeCommand = (cmd: SlashCommand) => {
    const next = `${cmd.name} `
    setValue(next)
    setSlashDismissed(true)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.length, next.length)
    })
  }

  // The skipped-image notice is advisory, not a state the user has to dismiss.
  useEffect(() => {
    if (!imageNotice) return
    const timer = window.setTimeout(() => setImageNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [imageNotice])

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
    // The slash menu owns the keyboard while it's up (TUI parity).
    const slashing = next.startsWith("/") && !next.includes(" ")
    setMentionOpen(!slashing && !!match && !!onSearchFiles)
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

  /** Single ingest path for the file picker, clipboard paste, and drag-drop.
   *  Non-images are ignored; oversized ones are skipped with a visible notice
   *  rather than dropped silently. `synthesizeNames` is for sources whose files
   *  have no useful name (clipboard items are typically "" or "image.png"). */
  const addImages = (files: Iterable<File> | FileList | null, opts: { synthesizeNames?: boolean } = {}) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue
      const name =
        opts.synthesizeNames || !file.name
          ? `Pasted image ${++pasteSeq.current}.${extensionFor(file.type)}`
          : file.name
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        const base64 = dataUrl.split(",")[1]
        if (!base64) return
        if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
          setImageNotice(`${name} is too large to attach (over ~5MB) — skipped.`)
          return
        }
        setImages((old) => [
          ...old,
          { id: `img-${++imageSeq.current}`, base64, mediaType: file.type, name, dataUrl },
        ])
      }
      reader.onerror = () => setImageNotice(`Couldn't read ${name} — skipped.`)
      reader.readAsDataURL(file)
    }
  }

  /** Clipboard paste: attach any image flavors and swallow the event, otherwise
   *  leave the default text paste completely alone. */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue
      const file = item.getAsFile()
      if (file) imageFiles.push(file)
    }
    if (imageFiles.length === 0) return
    e.preventDefault()
    addImages(imageFiles, { synthesizeNames: true })
  }

  /** True only for an OS file drag — ignore text/selection drags. */
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  const handleDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    // Without preventDefault the drop never fires (the webview navigates instead).
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    addImages(e.dataTransfer.files)
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

  // `/model` opens the existing picker instead of a new surface.
  useEffect(() => {
    if (!openModelPickerSignal) return
    handleOpenChange(true)
  }, [openModelPickerSignal])

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
    <div className="mx-auto w-full max-w-5xl px-4 pb-4">
      {/* Todos + queued messages render above the composer via TodosPanel /
          QueueChips (see App.tsx) so both surfaces stay in one place. */}
      {cacheGuard && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200"><span>This will resend ~{cacheGuard.approxTokens.toLocaleString()} tokens of cold context. Press ⏎ again to send, esc to cancel.</span><button type="button" onClick={onCacheConfirm} className="font-semibold text-primary hover:underline">Send anyway</button><button type="button" onClick={onCacheCancel} className="font-medium hover:underline">Cancel</button></div>}
      <div
        className={cn(
          "relative rounded-[22px] border border-border bg-card/80 p-2 shadow-panel backdrop-blur-xl transition-colors focus-within:border-ring/60",
          dragActive && "border-primary/60 bg-primary/5",
        )}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[22px] border-2 border-primary/50 border-dashed bg-card/80 text-[12px] font-medium text-primary">
            Drop images to attach
          </div>
        )}
        {imageNotice && (
          <div className="mx-2 mt-1 text-[11px] text-amber-600 dark:text-amber-400">{imageNotice}</div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
            {images.map((image, i) => (
              <span
                key={image.id}
                title={image.name}
                className="group relative size-10 overflow-hidden rounded-md border border-border bg-muted"
              >
                <img src={image.dataUrl} alt={image.name} className="size-full object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setImages((old) => old.filter((_, index) => index !== i))}
                  className="absolute top-0 right-0 flex size-4 items-center justify-center rounded-bl-md bg-background/85 text-muted-foreground opacity-80 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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
          onPaste={handlePaste}
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            grow(e.target)
            // Escape sticks while the `/token` is still being typed; a space or
            // a non-slash start means we're past the command and can re-arm.
            if (!next.startsWith("/") || next.includes(" ")) setSlashDismissed(false)
            setSlashIndex(0)
            updateMentions(next, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            // The cold-context guard owns Enter while visible: the user just hit
            // Enter to send, so a second Enter confirms without reaching for the mouse.
            if (cacheGuard) {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onCacheConfirm?.(); return }
              if (e.key === "Escape") { e.preventDefault(); onCacheCancel?.(); return }
            }
            if (slashOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((old) => Math.max(0, Math.min(slashMatches.length - 1, old + (e.key === "ArrowDown" ? 1 : -1)))) }
              else if (e.key === "Enter" && !e.shiftKey && slashMatches[slashIndex]) { e.preventDefault(); runCommand(slashMatches[slashIndex]!) }
              else if (e.key === "Tab" && slashMatches[slashIndex]) { e.preventDefault(); completeCommand(slashMatches[slashIndex]!) }
              else if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true) }
              // Everything else (typing, ⇧⏎ newline) keeps its default behavior.
              return
            }
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
        {slashOpen && <div className="mx-2 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-panel">{slashMatches.map((cmd, i) => <button type="button" key={cmd.name} onMouseDown={(e) => { e.preventDefault(); runCommand(cmd) }} onMouseMove={() => setSlashIndex(i)} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-accent", i === slashIndex && "bg-accent")}><ChevronRight className={cn("size-3 shrink-0 text-primary", i !== slashIndex && "opacity-0")} /><span className="shrink-0 font-medium font-mono text-foreground">{cmd.name}</span><span className="truncate text-muted-foreground">{cmd.description}</span></button>)}</div>}
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
                ) : activeMode ? (
                  // Same 14px slot as the chip icon, so swapping in a glyph
                  // can't change the button's height.
                  <span className="flex size-3.5 shrink-0 items-center justify-center text-[12px] leading-none">
                    {modeEmoji(activeMode)}
                  </span>
                ) : (
                  <Cpu className="size-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate font-medium text-foreground">
                  {/* A mode is the coarser choice: while one is in effect it
                      names the selector, and the executor chip beside it says
                      which model that resolves to. */}
                  {busy ? "Switching…" : activeMode || model.name}
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
                  {/* Modes first: applying one switches executor + sidekick +
                      advisor as a unit, so it supersedes a bare model pick.
                      No saved modes → no section, not an empty header. */}
                  {modes.length > 0 && onSelectMode && (
                    <>
                      <DropdownMenuLabel>Modes</DropdownMenuLabel>
                      {modes.map((m) => {
                        const selected = m.name === activeMode
                        return (
                          <DropdownMenuItem
                            key={m.name}
                            disabled={busy}
                            onClick={() => void onSelectMode(m.name)}
                            className={cn(selected && "bg-accent/60")}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center text-[13px] leading-none">
                              {modeEmoji(m.name)}
                            </span>
                            <div className="flex min-w-0 flex-col">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-medium text-[13px] text-foreground">
                                  {m.name}
                                </span>
                                {/* The emoji is identity; the check is state. */}
                                {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                              </span>
                              {m.detail && (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {m.detail}
                                </span>
                              )}
                            </div>
                          </DropdownMenuItem>
                        )
                      })}
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Models</DropdownMenuLabel>
                    </>
                  )}
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

            {status}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {contextMeter}
            {/* While running there are two send buttons competing for the same
                row, so the shortcut hint waits for a wider viewport. Idle keeps
                the original sm breakpoint. */}
            <span
              className={cn(
                "hidden items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground",
                streaming ? "md:flex" : "sm:flex",
              )}
            >
              <Kbd>⏎</Kbd> {streaming ? "queue" : "send"}
              {streaming && <><span>·</span><Kbd>⌥⏎</Kbd> steer</>}
              <Kbd>⇧⏎</Kbd> newline
            </span>
            {streaming && (
              <Button size="icon" variant="secondary" onClick={onStop} aria-label="Stop">
                <Square className="size-3.5 fill-current" />
              </Button>
            )}
            {streaming ? (
              // Steering is invisible unless we show it: while a turn runs, the
              // send affordance splits into the two deliveries the server
              // actually supports — prompt (queued after the turn) and steer
              // (interjected now, after the current tool call). Labels collapse
              // to icons at narrow widths so the row can never wrap.
              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => submit()}
                        disabled={nothingToSend}
                        aria-label="Queue prompt"
                        className="gap-1.5"
                      />
                    }
                  >
                    <ListPlus className="size-3.5" />
                    <span className="hidden sm:inline">Prompt</span>
                  </TooltipTrigger>
                  <TooltipPopup>Send after the current turn finishes</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submit("interject")}
                        disabled={nothingToSend}
                        aria-label="Steer the agent now"
                        // Amber matches the steer chip in QueueChips.
                        className="gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:bg-amber-500/15 dark:text-amber-400 [&_svg]:text-amber-600 dark:[&_svg]:text-amber-400"
                      />
                    }
                  >
                    <Zap className="size-3.5" />
                    <span className="hidden sm:inline">Steer</span>
                  </TooltipTrigger>
                  <TooltipPopup>Deliver now, right after the current tool call</TooltipPopup>
                </Tooltip>
              </div>
            ) : (
              <Button
                size="icon"
                onClick={() => submit()}
                disabled={nothingToSend}
                aria-label="Send"
                variant="default"
                className="rounded-full"
                title="Send"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
