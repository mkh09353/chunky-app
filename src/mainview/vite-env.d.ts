/// <reference types="vite/client" />

/** Injected by vite.config.ts: `/chunky-api` in Vite serve, else CHUNKY_URL. */
declare const __CHUNKY_BASE_URL__: string
/** Injected by vite.config.ts from CHUNKY_URL / default localhost:4620. Safe to show. */
declare const __CHUNKY_PROXY_TARGET__: string
/** Injected by vite.config.ts from ~/.chunky/state/settings.json — never log. */
declare const __CHUNKY_TOKEN__: string
