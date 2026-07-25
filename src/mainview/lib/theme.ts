import { useCallback, useEffect, useState } from "react"

export type ThemeMode = "light" | "dark" | "system"

const STORAGE_KEY = "chunky.theme"

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {
    /* storage disabled */
  }
  return "dark"
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

function resolve(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode
}

function apply(mode: ThemeMode): void {
  const resolved = resolve(mode)
  const el = document.documentElement
  el.classList.toggle("dark", resolved === "dark")
  el.style.colorScheme = resolved
}

/** Owns the light/dark/system preference and keeps <html> in sync. */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStored)

  useEffect(() => {
    apply(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
    if (mode !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => apply("system")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [mode])

  const resolved = resolve(mode)
  const toggle = useCallback(() => {
    setMode((m) => (resolve(m) === "dark" ? "light" : "dark"))
  }, [])

  return { mode, setMode, resolved, toggle }
}
