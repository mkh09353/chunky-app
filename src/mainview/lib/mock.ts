export interface Project {
  id: string
  name: string
  path: string
  owner: string
  mark: string
}

export type Role = "user" | "assistant"

export interface ChangedFile {
  path: string
  added: number
  removed: number
}

export interface ChangedFiles {
  total: number
  added: number
  removed: number
  files: ChangedFile[]
}

/** One line of a structured diff derived from tool I/O. */
export interface DiffLine {
  kind: "add" | "del" | "context"
  text: string
}

/** A structured, per-file diff extracted from an edit/write tool call. */
export interface FileDiff {
  path?: string
  added: number
  removed: number
  lines: DiffLine[]
  truncated?: boolean
}

/** Rich per-tool-call render data carried through to Message.tsx. */
export interface ToolBlockData {
  id: string
  name: string
  /** One-line argument preview derived from `input`. */
  inputPreview: string
  /** Pretty-printed input JSON (2-space), truncated. */
  inputJson: string
  /** Tool output (truncated) once done. */
  output?: string
  /** Streaming progress text while running (truncated). */
  progress?: string
  done: boolean
  ok?: boolean
  /** Structured diff when this is an edit/write tool, else null/undefined. */
  diff?: FileDiff | null
}

export interface MessageBlock {
  type: "text" | "code" | "worked" | "files" | "tool" | "thinking"
  content: string
  lang?: string
  /** worked / thinking block: the tool/step lines revealed when expanded. */
  steps?: string[]
  /** files block: the changed-files summary. */
  files?: ChangedFiles
  /** tool block: rich per-tool-call render data. */
  tool?: ToolBlockData
}

export interface Message {
  id: string
  role: Role
  blocks: MessageBlock[]
  model?: string
}

export type ThreadStatus =
  | { kind: "done" }
  | { kind: "working"; label: string }
  | { kind: "idle"; ago: string }

export interface Thread {
  id: string
  projectId: string
  title: string
  updated: string
  preview: string
  status: ThreadStatus
  branch: string
  number?: number
  messages: Message[]
}

export interface Model {
  id: string
  name: string
  vendor: string
  note: string
  /** Live provider readiness; omit/true in demo mode. */
  ready?: boolean
}

export const MODELS: Model[] = [
  { id: "chunky-max", name: "Chunky Max", vendor: "Chunky", note: "Deep reasoning · 200k ctx" },
  { id: "claude-sonnet", name: "Claude Sonnet 4.5", vendor: "Anthropic", note: "Balanced · fast" },
  { id: "gpt-5-codex", name: "GPT-5 Codex", vendor: "OpenAI", note: "Agentic coding" },
  { id: "gemini-flash", name: "Gemini 2.5 Flash", vendor: "Google", note: "Cheap · 1M ctx" },
  { id: "grok-code", name: "Grok Code", vendor: "xAI", note: "Snappy edits" },
]

export const PROJECTS: Project[] = [
  { id: "p1", name: "chunky-app", path: "~/Downloads/chunky-app", owner: "chunky-labs", mark: "C" },
  { id: "p2", name: "relay-server", path: "~/dev/relay", owner: "chunky-labs", mark: "R" },
  { id: "p3", name: "chunky-site", path: "~/dev/chunky-site", owner: "chunky-labs", mark: "S" },
]

const HOOK_CODE = `export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])

  return debounced
}`

const DIFF_CODE = `// src/mainview/index.html — pins the theme before first paint
;(function () {
  const stored = localStorage.getItem("chunky.theme")
  const dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  document.documentElement.classList.toggle("dark", dark)
})()`

const RECONNECT_CODE = `let delay = 500
function reconnect() {
  setTimeout(connect, Math.min(delay, 30_000))
  delay = Math.min(delay * 2, 30_000)
}`

const POLISH_REPORT = `I went through the whole surface and tightened it up so it reads like a real product, not a prototype. Here's the rundown.

**Menu cleanup:** collapsed the three overflow actions into a single \`⋯\` menu and moved *Share* up beside the breadcrumb, so the header now reads cleanly left-to-right.

### What changed

- Rewrote the sidebar rows to a **dense, status-first** layout — every row now shows \`owner/repo\`, a live status, its branch, and the PR number.
- Assistant replies render real prose now: headings, lists, inline \`code\` pills, and [links](https://chunky.to) are all on one consistent type scale.
- Unified every corner on \`--radius: 0.7rem\` and pulled all surfaces onto a single shadow token, so panels layer instead of fighting.

### Follow-ups

1. Wire the \`View PR\` split-button to the real GitHub API.
2. Add a keyboard map for the transcript actions (\`c\` to copy, \`r\` to regenerate).
3. Ship a compact density toggle for the sidebar.

Full spacing rationale is in the [design notes](https://chunky.to/design) if you want the why behind the numbers.`

const CHANGED: ChangedFiles = {
  total: 37,
  added: 723,
  removed: 168,
  files: [
    { path: "src/mainview/components", added: 412, removed: 96 },
    { path: "src/mainview/components/ui", added: 138, removed: 41 },
    { path: "src/mainview/lib", added: 97, removed: 18 },
    { path: "src/mainview", added: 58, removed: 9 },
    { path: "src/bun", added: 18, removed: 4 },
  ],
}

export const THREADS: Thread[] = [
  {
    id: "t1",
    projectId: "p1",
    title: "Polish sidebar density + chat typography",
    updated: "now",
    preview: "Tightened the whole surface — dense rows, real prose…",
    status: { kind: "working", label: "7m" },
    branch: "feat/ui-polish",
    number: 4311,
    messages: [
      {
        id: "m1",
        role: "user",
        blocks: [
          {
            type: "text",
            content:
              "The app is good but not great — it's missing that shadcn polish. Tighten the sidebar density, make assistant messages read like real prose, and give me a changed-files summary at the end. Go.",
          },
        ],
      },
      {
        id: "m2",
        role: "assistant",
        model: "Chunky Max",
        blocks: [
          {
            type: "worked",
            content: "3m 11s",
            steps: [
              "Read 14 files across components/ and lib/",
              "Edited Sidebar.tsx, Message.tsx, ChatView.tsx, index.css",
              "Added a tiny markdown renderer (lib/markdown.tsx)",
              "Ran tsgo — typecheck clean",
              "Built the vite bundle — 0 errors",
            ],
          },
          { type: "text", content: POLISH_REPORT },
          { type: "code", lang: "tsx", content: HOOK_CODE },
          {
            type: "text",
            content:
              "That hook now powers the sidebar filter — it keeps typing buttery on a 300-row list while cutting re-renders by ~90%.",
          },
          { type: "files", content: "", files: CHANGED },
          {
            type: "text",
            content: "Want me to open a PR against `main`, or keep iterating on the branch?",
          },
        ],
      },
    ],
  },
  {
    id: "t2",
    projectId: "p1",
    title: "Fix theme flash on cold start",
    updated: "36m",
    preview: "Move theme resolution into a pre-paint script…",
    status: { kind: "done" },
    branch: "fix/theme-flash",
    number: 4288,
    messages: [
      {
        id: "m3",
        role: "user",
        blocks: [
          { type: "text", content: "The app flashes light for a frame before going dark. Fix it?" },
        ],
      },
      {
        id: "m4",
        role: "assistant",
        model: "Claude Sonnet 4.5",
        blocks: [
          {
            type: "worked",
            content: "48s",
            steps: ["Traced the first-paint order", "Edited index.html + lib/theme.ts"],
          },
          {
            type: "text",
            content:
              "That flash happens because the module bundle runs *after* first paint. The fix is to resolve the theme in an inline `<script>` in `index.html` so the `dark` class is set **before** anything renders:",
          },
          { type: "code", lang: "ts", content: DIFF_CODE },
          { type: "text", content: "First frame is now already correct — no flash on any cold start." },
        ],
      },
    ],
  },
  {
    id: "t3",
    projectId: "p1",
    title: "Wire up the command palette",
    updated: "2h",
    preview: "⌘K opens a filtered, keyboard-navigable dialog…",
    status: { kind: "done" },
    branch: "feat/cmd-k",
    number: 4270,
    messages: [
      {
        id: "m5",
        role: "user",
        blocks: [{ type: "text", content: "How should the ⌘K palette be structured?" }],
      },
      {
        id: "m6",
        role: "assistant",
        model: "GPT-5 Codex",
        blocks: [
          {
            type: "text",
            content:
              "Build it from your Dialog + Input primitives:\n\n- a controlled `open` state toggled by a global keydown listener\n- a fuzzy filter over one flat action list\n- arrow-key navigation over the visible results\n\nThat keeps it dependency-free and matches the rest of the kit.",
          },
        ],
      },
    ],
  },
  {
    id: "t4",
    projectId: "p2",
    title: "Reconnect websocket with backoff",
    updated: "5h",
    preview: "Exponential backoff with jitter, capped at 30s…",
    status: { kind: "done" },
    branch: "fix/ws-reconnect",
    number: 182,
    messages: [
      {
        id: "m7",
        role: "user",
        blocks: [{ type: "text", content: "Add reconnect logic to the relay client." }],
      },
      {
        id: "m8",
        role: "assistant",
        model: "Chunky Max",
        blocks: [
          {
            type: "text",
            content:
              "Use **exponential backoff with jitter**, capped at 30s, and reset the delay on a clean open:",
          },
          { type: "code", lang: "ts", content: RECONNECT_CODE },
          { type: "text", content: "I also removed the `online`/`offline` listeners — they were the source of the race." },
        ],
      },
    ],
  },
  {
    id: "t5",
    projectId: "p2",
    title: "Rate-limit the handshake endpoint",
    updated: "1d",
    preview: "Token bucket, 20 req/min per IP…",
    status: { kind: "done" },
    branch: "feat/ratelimit",
    number: 176,
    messages: [
      {
        id: "m11",
        role: "user",
        blocks: [{ type: "text", content: "Add a rate limit to the handshake route." }],
      },
      {
        id: "m12",
        role: "assistant",
        model: "GPT-5 Codex",
        blocks: [
          {
            type: "text",
            content: "Added a token-bucket limiter: **20 req/min per IP**, returning `429` with a `Retry-After` header when exceeded.",
          },
        ],
      },
    ],
  },
  {
    id: "t6",
    projectId: "p3",
    title: "Landing page hero copy",
    updated: "2d",
    preview: "Three punchy taglines…",
    status: { kind: "done" },
    branch: "content/hero",
    messages: [
      {
        id: "m9",
        role: "user",
        blocks: [{ type: "text", content: "Give me hero taglines for the Chunky landing page." }],
      },
      {
        id: "m10",
        role: "assistant",
        model: "Gemini 2.5 Flash",
        blocks: [
          {
            type: "text",
            content:
              "A few directions:\n\n1. **Your agent, unleashed.**\n2. **Ship code at the speed of thought.**\n3. **The coding agent that actually finishes.**\n\nMy pick is #3 — it leans into the reliability angle competitors dodge.",
          },
        ],
      },
    ],
  },
]

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  group: string
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  { id: "new-thread", label: "New thread", hint: "⌘N", group: "Actions" },
  { id: "new-project", label: "Add project…", hint: "", group: "Actions" },
  { id: "search", label: "Search threads", hint: "⌘F", group: "Actions" },
  { id: "toggle-theme", label: "Toggle theme", hint: "⌘⇧L", group: "Actions" },
  { id: "settings", label: "Open settings", hint: "⌘,", group: "Actions" },
  { id: "model-max", label: "Switch to Chunky Max", group: "Models" },
  { id: "model-sonnet", label: "Switch to Claude Sonnet 4.5", group: "Models" },
  { id: "model-codex", label: "Switch to GPT-5 Codex", group: "Models" },
  { id: "thread-1", label: "Polish sidebar density + chat typography", group: "Recent threads" },
  { id: "thread-2", label: "Fix theme flash on cold start", group: "Recent threads" },
  { id: "thread-4", label: "Reconnect websocket with backoff", group: "Recent threads" },
]
