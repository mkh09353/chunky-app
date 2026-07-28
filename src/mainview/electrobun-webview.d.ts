/**
 * App-side type for Electrobun's `<electrobun-webview>` custom element
 * (registered by the desktop preload; absent in `dev:web`).
 *
 * Electrobun already augments `HTMLElementTagNameMap` with `WebviewTagElement`,
 * so this only adds the internal member BrowserPane needs for teardown.
 *
 * Deliberately NOT declared as a JSX intrinsic element: React 19 assigns props
 * on custom elements as *properties* whenever the name exists on the instance
 * (`key in domElement`), and the element exposes a getter-only `sandbox`. So
 * `<electrobun-webview sandbox="">` in JSX throws "Attempted to assign to
 * readonly property" while committing, which tears down the whole React root
 * and blanks the window. Create the element imperatively instead — see
 * src/mainview/components/BrowserPane.tsx.
 */
import type { WebviewTagElement } from "electrobun/view"

declare global {
  interface ElectrobunWebviewElement extends WebviewTagElement {
    /**
     * Deferred (requestAnimationFrame) creation of the native child webview.
     * Overridable to cancel an init that has not started yet.
     */
    initWebview: () => Promise<void>
  }
}

export {}
