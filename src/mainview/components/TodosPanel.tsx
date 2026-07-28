import { CheckCircle2, ChevronRight, Circle, ListChecks, Loader2, XCircle } from "lucide-react"
import { useState } from "react"
import type { TodoSnapshot } from "@chunky/protocol"
import { cn } from "~/lib/cn"

function TodoRow({ todo }: { todo: TodoSnapshot }) {
  const label =
    todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content
  return (
    <li className="flex items-start gap-2 px-3 py-1.5 text-[12.5px]">
      {todo.status === "completed" ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : todo.status === "in_progress" ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
      ) : todo.status === "cancelled" ? (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
      ) : (
        <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
      )}
      <span
        className={cn(
          "min-w-0",
          todo.status === "completed" && "text-muted-foreground line-through",
          todo.status === "cancelled" && "text-muted-foreground/60 line-through",
          todo.status === "in_progress" && "font-medium text-foreground",
          todo.status === "pending" && "text-foreground/90",
        )}
      >
        {label}
      </span>
    </li>
  )
}

/** Collapsible plan/checklist pinned above the Composer. Hidden when empty. */
export function TodosPanel({ todos }: { todos: TodoSnapshot[] }) {
  const [open, setOpen] = useState(false)
  if (!todos || todos.length === 0) return null
  const total = todos.length
  const completed = todos.filter((t) => t.status === "completed").length

  return (
    <div className="mx-auto w-full max-w-5xl px-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card/70 shadow-xs backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronRight
            className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <ListChecks className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-[12.5px]">Tasks</span>
          <span className="text-[12px] text-muted-foreground">
            · {completed}/{total}
          </span>
        </button>
        {open && (
          <ul className="border-border border-t py-1">
            {todos.map((t) => (
              <TodoRow key={t.id} todo={t} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
