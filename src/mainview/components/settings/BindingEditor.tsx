// The compact per-skill model binding editor, shared by the Skills section
// (where the lock strength is part of the decision) and the PR Reviews section
// (where every lens binding is advisory, so the lock control is hidden).
//
// Extracted verbatim from SkillsSection so there is exactly one implementation
// of "pick a model, optionally an effort, save or remove".
import { useState } from "react"
import type { SkillModelBinding } from "@chunky/protocol"
import type { ModelRow } from "~/lib/configApi"
import { bindingModelKey, parseBindingDraft } from "~/lib/skills"
import { Button } from "../ui/button"
import {
  EffortSelect,
  InlineError,
  ModelSelect,
  Select,
  Spinner,
  TextInput,
} from "./common"

/**
 * The picker is the shared ModelSelect, so it keeps a server-confirmed model
 * selectable even when the catalog is incomplete; with no catalog at all it
 * degrades to a typed `provider/model`.
 */
export function BindingEditor({
  rows,
  binding,
  busy,
  showLock = true,
  onSave,
  onRemove,
  onCancel,
}: {
  rows: ModelRow[]
  binding: SkillModelBinding | undefined
  busy: boolean
  /** False hides the lock control; the binding keeps its lock (default "prefer"). */
  showLock?: boolean
  onSave: (binding: SkillModelBinding) => void
  onRemove: () => void
  onCancel: () => void
}) {
  const [modelKey, setModelKey] = useState(bindingModelKey(binding))
  const [effort, setEffort] = useState(binding?.effort ?? "")
  const [lock, setLock] = useState<SkillModelBinding["lock"]>(binding?.lock ?? "prefer")
  const [invalid, setInvalid] = useState<string | null>(null)

  const save = () => {
    const result = parseBindingDraft({ modelKey, effort, lock })
    if (!result.ok) {
      setInvalid(result.error)
      return
    }
    setInvalid(null)
    onSave(result.binding)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        {rows.length > 0 ? (
          <ModelSelect rows={rows} value={modelKey} onChange={setModelKey} disabled={busy} />
        ) : (
          <TextInput
            value={modelKey}
            onChange={setModelKey}
            placeholder="provider/model"
            disabled={busy}
            monospace
            className="max-w-[15rem]"
          />
        )}
        <EffortSelect value={effort} onChange={setEffort} allowInherit disabled={busy} />
        {showLock && (
          <Select
            value={lock}
            onChange={(v) => setLock(v === "require" ? "require" : "prefer")}
            disabled={busy}
            className="w-[11rem]"
          >
            <option value="prefer">Prefer (semi lock)</option>
            <option value="require">Require (hard lock)</option>
          </Select>
        )}
      </div>

      {invalid && <InlineError>{invalid}</InlineError>}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? <Spinner /> : null}
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {binding && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRemove}
            className="ml-auto text-destructive hover:bg-destructive/10"
          >
            Remove binding
          </Button>
        )}
      </div>
    </div>
  )
}
