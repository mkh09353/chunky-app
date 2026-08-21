import {
  Boxes,
  Cookie,
  Cpu,
  Eye,
  GitPullRequest,
  Layers,
  Mic,
  Settings2,
  Smartphone,
  Sparkles,
  UserCog,
  Workflow,
  Wrench,
} from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "~/lib/cn"
import { DRAG_REGION } from "~/lib/dragRegion"
import { Dialog, DialogPopup } from "../ui/dialog"
import { ScrollArea } from "../ui/scroll-area"
import { AdvisorSection, ReviewerSection, SoloAdvisorSection } from "./AgentConfigSection"
import { CookiesSection } from "./CookiesSection"
import { GeneralSection } from "./GeneralSection"
import { ModelsSection } from "./ModelsSection"
import { ModesSection } from "./ModesSection"
import { PrReviewsSection } from "./PrReviewsSection"
import { ProvidersSection, type SetupProviderChat } from "./ProvidersSection"
import { RelaySection } from "./RelaySection"
import { SidekickSection } from "./SidekickSection"
import { SkillsSection } from "./SkillsSection"
import { VoiceSection } from "./VoiceSection"
import { WorkflowSection } from "./WorkflowSection"

type SectionId =
  | "providers"
  | "models"
  | "advisor"
  | "reviewer"
  | "sidekick"
  | "modes"
  | "skills"
  | "prReviews"
  | "workflow"
  | "voice"
  | "cookies"
  | "relay"
  | "general"

const NAV: { id: SectionId; label: string; icon: typeof Cpu }[] = [
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "models", label: "Models", icon: Cpu },
  { id: "advisor", label: "Advisor", icon: UserCog },
  { id: "reviewer", label: "Reviewer", icon: Eye },
  { id: "sidekick", label: "Sidekick", icon: Wrench },
  { id: "modes", label: "Modes", icon: Layers },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "prReviews", label: "PR Reviews", icon: GitPullRequest },
  { id: "workflow", label: "Workflow", icon: Workflow },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "cookies", label: "Browser cookies", icon: Cookie },
  { id: "relay", label: "Relay", icon: Smartphone },
  { id: "general", label: "General", icon: Settings2 },
]

function isSectionId(v: string | undefined): v is SectionId {
  return NAV.some((n) => n.id === v)
}

export interface SettingsConnectionInfo {
  state: string
  baseUrl: string
  workspace: string
  sessionCount: number
  mode: "live" | "demo"
}

/** The sidebar name, owned by App. Settings edits it but never reads it from
 *  git itself — `gitName` is the fallback the editor shows, not a saved value. */
export interface SettingsIdentityInfo {
  /** The configured override, or "" when the git name is in use. */
  override: string
  /** `git config user.name`, or "" when it can't be read. */
  gitName: string
  /** Persist a new override; "" clears it. */
  onChange: (next: string) => void
}

function renderSection(
  id: SectionId,
  connection?: SettingsConnectionInfo,
  onModesChanged?: () => void,
  identity?: SettingsIdentityInfo,
  onSetupProviderChat?: SetupProviderChat,
) {
  switch (id) {
    case "providers":
      return <ProvidersSection onSetupProviderChat={onSetupProviderChat} />
    case "models":
      return <ModelsSection />
    case "advisor":
      // The always-on advisor, then its solo counterpart: same surface, and
      // solo is the state a raw model pick puts you in, so it belongs here
      // rather than in a section of its own.
      return (
        <div className="flex flex-col gap-8">
          <AdvisorSection />
          <SoloAdvisorSection />
        </div>
      )
    case "reviewer":
      return <ReviewerSection />
    case "sidekick":
      return <SidekickSection />
    case "modes":
      return <ModesSection onApplied={onModesChanged} />
    case "skills":
      return <SkillsSection />
    case "prReviews":
      return <PrReviewsSection />
    case "workflow":
      return <WorkflowSection />
    case "voice":
      return <VoiceSection />
    case "cookies":
      return <CookiesSection />
    case "relay":
      return <RelaySection connection={connection} />
    case "general":
      return <GeneralSection connection={connection} identity={identity} />
  }
}

export function SettingsCenter({
  open,
  onOpenChange,
  initialSection,
  connection,
  identity,
  onModesChanged,
  onSetupProviderChat,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: string
  connection?: SettingsConnectionInfo
  /** Sidebar display name + its git fallback, supplied and persisted by App. */
  identity?: SettingsIdentityInfo
  /** Called after a mode is applied/saved/deleted (refresh models + aliases). */
  onModesChanged?: () => void
  /** Providers → "Set it up with a chat": App closes this dialog and opens a
   *  new session seeded with a provider-setup brief. Omitted (e.g. demo mode,
   *  no server) hides the option instead of rendering a dead button. */
  onSetupProviderChat?: SetupProviderChat
}) {
  const [section, setSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "providers",
  )

  // Sync to a requested section each time the dialog is opened.
  useEffect(() => {
    if (open && isSectionId(initialSection)) setSection(initialSection)
  }, [open, initialSection])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="flex h-[82vh] max-h-[720px] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden p-0">
        {/* The modal backdrop covers the window's own drag strips, so the
            settings header doubles as the drag handle while this is open. */}
        <header
          className={cn(
            DRAG_REGION,
            "flex shrink-0 items-center gap-2.5 border-border/70 border-b px-5 py-3.5",
          )}
        >
          <div className="flex size-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
            <Settings2 className="size-4 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-[14px] tracking-tight">Settings</span>
            <span className="text-[11.5px] text-muted-foreground">
              Configure providers, models, and agents
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-border/70 border-r bg-muted/20 p-2.5">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  section === id
                    ? "bg-sidebar-accent font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                )}
              >
                <Icon
                  className={cn("size-4 shrink-0", section === id ? "text-primary" : "opacity-70")}
                />
                {label}
              </button>
            ))}
          </nav>

          <ScrollArea className="min-w-0 flex-1" viewportClassName="p-5">
            {renderSection(section, connection, onModesChanged, identity, onSetupProviderChat)}
          </ScrollArea>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
