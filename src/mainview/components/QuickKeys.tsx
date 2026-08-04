// Quick keys: one calm row of user-defined prompt chips above the composer.
//
// A chip sends its configured prompt straight down the composer's own send
// path — no prefill, no confirmation — so the row is disabled whenever the
// composer itself could not send (streaming, offline, no session). The trailing
// dashed "+" is always there, so the feature stays discoverable with nothing
// configured yet.
//
// Config is owned by the caller (App holds the list and persists it through the
// Bun desktop settings); this component only edits and reports.
import { Pencil, Plus, Smile } from "lucide-react"
import type * as React from "react"
import { useEffect, useState } from "react"
import { cn } from "~/lib/cn"
import {
  draftFromQuickKey,
  emptyQuickKeyDraft,
  EMOJI_CHOICES,
  hasQuickKeyErrors,
  hotkeyLabel,
  MAX_QUICK_KEYS,
  nextQuickKeyId,
  quickKeyFromDraft,
  removeQuickKey,
  upsertQuickKey,
  validateQuickKey,
  type QuickKey,
  type QuickKeyDraft,
  type QuickKeyErrors,
} from "~/lib/quickKeys"
import { Button } from "./ui/button"
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogHeader } from "./ui/dialog"
import { Input } from "./ui/input"
import { Kbd } from "./ui/kbd"
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover"
import { Textarea } from "./ui/textarea"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

export function QuickKeys({
  keys,
  disabled = false,
  editorOpen,
  onEditorOpenChange,
  onChange,
  onRun,
}: {
  keys: QuickKey[]
  /** Mirrors the composer: dimmed and inert while a run streams or offline. */
  disabled?: boolean
  /** Controlled by the caller so its global hotkeys can stand down. */
  editorOpen: boolean
  onEditorOpenChange: (open: boolean) => void
  /** The full list after an edit; the caller persists it. */
  onChange: (keys: QuickKey[]) => void
  onRun: (key: QuickKey) => void
}) {
  // Which key the dialog is editing (null = creating a new one).
  const [editing, setEditing] = useState<QuickKey | null>(null)
  const [draft, setDraft] = useState<QuickKeyDraft>(emptyQuickKeyDraft)
  const [errors, setErrors] = useState<QuickKeyErrors>({})

  // A dialog closed from the backdrop/Escape must not leave a stale draft.
  useEffect(() => {
    if (editorOpen) return
    setEditing(null)
    setDraft(emptyQuickKeyDraft())
    setErrors({})
  }, [editorOpen])

  const openEditor = (key: QuickKey | null) => {
    setEditing(key)
    setDraft(key ? draftFromQuickKey(key) : emptyQuickKeyDraft())
    setErrors({})
    onEditorOpenChange(true)
  }

  const save = () => {
    const found = validateQuickKey(draft, keys, editing?.id ?? null)
    setErrors(found)
    if (hasQuickKeyErrors(found)) return
    const id = editing?.id ?? nextQuickKeyId(keys)
    onChange(upsertQuickKey(keys, quickKeyFromDraft(draft, id)))
    onEditorOpenChange(false)
  }

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    save()
  }

  const remove = () => {
    if (!editing) return
    onChange(removeQuickKey(keys, editing.id))
    onEditorOpenChange(false)
  }

  const full = keys.length >= MAX_QUICK_KEYS && !editing

  return (
    <div className="mx-auto flex w-full max-w-5xl items-center px-4">
      {/* One scroller holding one auto-margined group: with room to spare the
          margins centre the chips over the composer below; once the row is full
          they collapse to zero, so it still scrolls from the left edge. */}
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto flex items-center gap-1.5 whitespace-nowrap">
          <span className="mr-0.5 shrink-0 select-none font-medium text-[10px] text-muted-foreground/70 uppercase tracking-[0.14em]">
            Quick
          </span>
          {keys.map((key) => (
            <QuickKeyChip
              key={key.id}
              entry={key}
              disabled={disabled}
              onRun={() => onRun(key)}
              onEdit={() => openEditor(key)}
            />
          ))}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label="Add a quick key"
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/70 border-dashed text-muted-foreground outline-none transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                  disabled={full}
                  onClick={() => openEditor(null)}
                  type="button"
                />
              }
            >
              <Plus className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>{full ? `Limit is ${MAX_QUICK_KEYS} quick keys` : "New quick key"}</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <Dialog onOpenChange={onEditorOpenChange} open={editorOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit quick key" : "New quick key"}</DialogTitle>
            <DialogDescription>
              Sends its prompt to the current session as soon as you click it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 px-6 pt-2 pb-1">
            <div className="flex gap-3">
              {/* No emoji placeholder: a ghosted 🚢 in an empty field reads as an icon
                  that is already chosen. The live preview below is the only place
                  an emoji ever appears, so what you see is what the chip gets. */}
              <Field className="w-28 shrink-0" error={errors.emoji} label="Icon">
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label="Icon (optional emoji)"
                    className="min-w-0 flex-1 text-center text-base"
                    onChange={(event) => setDraft((d) => ({ ...d, emoji: event.target.value }))}
                    onKeyDown={submitOnEnter}
                    value={draft.emoji}
                  />
                  {/* Typing or pasting still works; this is just a reliable way
                      in, since the macOS palette is flaky inside WKWebView. */}
                  <EmojiPicker
                    onPick={(emoji) => setDraft((d) => ({ ...d, emoji }))}
                    value={draft.emoji.trim()}
                  />
                </div>
              </Field>
              <Field className="min-w-0 flex-1" error={errors.label} label="Label">
                <Input
                  autoFocus
                  onChange={(event) => setDraft((d) => ({ ...d, label: event.target.value }))}
                  onKeyDown={submitOnEnter}
                  placeholder="Ship it!"
                  value={draft.label}
                />
              </Field>
            </div>

            <div className="flex items-center gap-2">
              <span className="shrink-0 font-medium text-[12px] text-muted-foreground">Preview</span>
              <span className={cn(CHIP_SHELL, CHIP_IDLE, "min-w-0 max-w-full px-2.5")}>
                <ChipContent
                  emoji={draft.emoji.trim()}
                  hotkey={draft.hotkey}
                  label={draft.label.trim() || "Label"}
                />
              </span>
              {!draft.emoji.trim() && (
                <span className="text-[11px] text-muted-foreground/70">No icon set</span>
              )}
            </div>

            <Field error={errors.prompt} label="Prompt">
              <div className="rounded-lg border border-input px-3 py-2 shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25">
                <Textarea
                  onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                  placeholder="Commit the current work and open a PR."
                  rows={4}
                  value={draft.prompt}
                />
              </div>
            </Field>

            <Field
              error={errors.hotkey}
              hint="Optional. Fires as ⌘⇧ plus this letter."
              label="Hotkey"
            >
              {/* Single letter; the icon field above takes the emoji. */}
              <Input
                className="w-20 uppercase"
                maxLength={1}
                onChange={(event) => setDraft((d) => ({ ...d, hotkey: event.target.value }))}
                onKeyDown={submitOnEnter}
                placeholder="D"
                value={draft.hotkey.toUpperCase()}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-2 px-6 pt-3 pb-6">
            {editing ? (
              <Button
                className="text-destructive hover:bg-destructive/10"
                onClick={remove}
                size="sm"
                variant="ghost"
              >
                Delete
              </Button>
            ) : (
              <span />
            )}
            <span className="flex items-center gap-2">
              <Button onClick={() => onEditorOpenChange(false)} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button onClick={save} size="sm">
                Save
              </Button>
            </span>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  )
}

/** Pill shell and resting tone, shared by the row and the editor's preview. */
const CHIP_SHELL = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border text-[12px]"
const CHIP_IDLE = "border-border/70 bg-muted/40 text-foreground"

/** Emoji + label + hotkey badge, evenly spaced. */
function ChipContent({
  emoji,
  label,
  hotkey,
}: {
  emoji: string
  label: string
  hotkey: string
}) {
  const badge = hotkeyLabel(hotkey)
  return (
    <>
      {emoji ? (
        <span aria-hidden className="shrink-0 text-[13px] leading-none">
          {emoji}
        </span>
      ) : null}
      <span className="truncate">{label}</span>
      {badge ? <Kbd className="h-4 shrink-0 px-1 text-[10px]">{badge}</Kbd> : null}
    </>
  )
}

/**
 * The Icon field's way in: a curated grid, not a dataset. Clicking a face
 * replaces whatever the field holds and closes the popover — the draft is the
 * only state it touches, so validateQuickKey still has the last word.
 *
 * Non-modal (Base UI's default), so it nests inside the editor Dialog without
 * two focus traps arguing; the popup portals out, so the dialog never clips it.
 */
function EmojiPicker({ value, onPick }: { value: string; onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label="Choose an emoji"
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
            type="button"
          />
        }
      >
        <Smile className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[19rem]" side="bottom">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_CHOICES.map((emoji) => (
            <button
              aria-label={`Use ${emoji}`}
              aria-pressed={value === emoji}
              className={cn(
                "inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-[17px] leading-none outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                value === emoji && "bg-accent",
              )}
              key={emoji}
              onClick={() => {
                onPick(emoji)
                setOpen(false)
              }}
              type="button"
            >
              {emoji}
            </button>
          ))}
        </div>
        <p className="px-1 pt-2 text-[11px] text-muted-foreground/70">
          Or type any emoji in the field.
        </p>
      </PopoverPopup>
    </Popover>
  )
}

function QuickKeyChip({
  entry,
  disabled,
  onRun,
  onEdit,
}: {
  entry: QuickKey
  disabled: boolean
  onRun: () => void
  onEdit: () => void
}) {
  return (
    <span
      className={cn(
        "group/qk inline-flex h-7 shrink-0 items-center rounded-full border transition-colors",
        disabled
          ? "border-border/50 bg-muted/20 opacity-50"
          : "border-border/70 bg-muted/40 hover:border-border hover:bg-muted/70",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            // Symmetric padding: the pencil beside it is zero-width until hover,
            // so the emoji/label/badge sit centred in the pill at rest.
            <button
              className="inline-flex h-full max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
              disabled={disabled}
              onClick={onRun}
              type="button"
            />
          }
        >
          <ChipContent emoji={entry.emoji} hotkey={entry.hotkey} label={entry.label} />
        </TooltipTrigger>
        <TooltipPopup className="max-w-xs whitespace-pre-wrap break-words text-left">
          {entry.prompt.length > 200 ? `${entry.prompt.slice(0, 200)}…` : entry.prompt}
        </TooltipPopup>
      </Tooltip>
      {/* Collapsed to nothing until the chip is hovered or the button itself
          takes focus — keyboard users still reach it by tabbing. */}
      <span className="flex h-full w-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 group-focus-within/qk:w-6 group-focus-within/qk:opacity-100 group-hover/qk:w-6 group-hover/qk:opacity-100">
        <button
          aria-label={`Edit ${entry.label}`}
          className="mr-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onEdit}
          type="button"
        >
          <Pencil className="size-3" />
        </button>
      </span>
    </span>
  )
}

function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string
  error?: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="font-medium text-[12px] text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-[11px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground/70">{hint}</span>
      ) : null}
    </label>
  )
}
