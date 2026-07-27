import type { DetailedHTMLProps, HTMLAttributes } from "react"

declare global {
  interface ElectrobunWebviewElement extends HTMLElement {
    src: string | null
    renderer: "cef" | "native"
    loadURL: (url: string) => void
    reload: () => void
    canGoBack: () => Promise<boolean>
    canGoForward: () => Promise<boolean>
    goBack: () => void
    goForward: () => void
    on: (event: "did-navigate" | "did-navigate-in-page" | "did-commit-navigation" | "dom-ready", listener: (event: CustomEvent) => void) => void
    off: (event: "did-navigate" | "did-navigate-in-page" | "did-commit-navigation" | "dom-ready", listener: (event: CustomEvent) => void) => void
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": DetailedHTMLProps<HTMLAttributes<ElectrobunWebviewElement>, ElectrobunWebviewElement> & {
        src?: string
        sandbox?: ""
        renderer?: "cef" | "native"
      }
    }
  }
}
