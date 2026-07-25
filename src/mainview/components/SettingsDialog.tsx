import { Monitor, Moon, Sun } from "lucide-react"
import type * as React from "react"
import type { ThemeMode } from "~/lib/theme"
import { cn } from "~/lib/cn"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog"
import { Separator } from "./ui/separator"
import { Switch } from "./ui/switch"

function Row({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-[13.5px]">{title}</span>
        <span className="text-[12px] text-muted-foreground">{description}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

export function SettingsDialog({
  open,
  onOpenChange,
  mode,
  onModeChange,
  connection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ThemeMode
  onModeChange: (m: ThemeMode) => void
  connection?: {
    state: string
    baseUrl: string
    workspace: string
    sessionCount: number
    mode: "live" | "demo"
  }
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Personalize how Chunky looks and behaves.</DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6">
          {connection && (
            <>
              <p className="pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Connection
              </p>
              <Row
                title="Server"
                description={
                  connection.mode === "demo"
                    ? "Demo mode — mock data only."
                    : `${connection.state} · ${connection.sessionCount} session${connection.sessionCount === 1 ? "" : "s"}`
                }
              >
                <span className="max-w-[11rem] truncate font-mono text-[11px] text-muted-foreground">
                  {connection.baseUrl.replace(/^https?:\/\//, "")}
                </span>
              </Row>
              {connection.workspace ? (
                <>
                  <Separator />
                  <Row title="Workspace" description={connection.workspace}>
                    <span />
                  </Row>
                </>
              ) : null}
              <Separator />
            </>
          )}

          <p className="pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Appearance
          </p>
          <Row title="Theme" description="Switch between light, dark, and system.">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onModeChange(value)}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1 font-medium text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                    mode === value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Separator />
          <Row title="Reduce motion" description="Minimize non-essential animations.">
            <Switch />
          </Row>
          <Separator />

          <p className="pt-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Chat
          </p>
          <Row title="Stream responses" description="Render tokens as they arrive.">
            <Switch defaultChecked />
          </Row>
          <Separator />
          <Row title="Send on Enter" description="Enter sends; Shift+Enter adds a newline.">
            <Switch defaultChecked />
          </Row>
          <Separator />
          <Row title="Show line numbers" description="In fenced code blocks.">
            <Switch defaultChecked />
          </Row>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
