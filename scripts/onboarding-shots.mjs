// Dev helper: screenshot the fullscreen onboarding flow (3 steps × light/dark)
// against the Vite dev server with `?onboarding=1` fixture data.
//
// Playwright is intentionally NOT a dependency of this app; install it out of
// tree and run the script from there:
//   bun run dev:web &
//   mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright
//   npx playwright install chromium
//   cp <repo>/scripts/onboarding-shots.mjs /tmp/pw/ && node /tmp/pw/onboarding-shots.mjs
import { mkdirSync } from "node:fs"
import { chromium } from "playwright"

const OUT = "/tmp/chunky-onboarding"
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()

for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript(`localStorage.setItem("chunky.theme", ${JSON.stringify(theme)})`)
  const page = await ctx.newPage()
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${theme}] console:`, m.text())
  })
  await page.goto("http://localhost:5173/?onboarding=1", { waitUntil: "load" })
  await page.waitForSelector('[role="dialog"][aria-label="Set up Chunky"]', { timeout: 15000 })
  await page.waitForTimeout(1200)

  await page.screenshot({ path: `${OUT}/step1-providers-${theme}.png`, fullPage: true })

  await page.getByRole("button", { name: "Next", exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/step2-mode-${theme}.png`, fullPage: true })

  await page.getByRole("button", { name: "Next", exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/step3-finish-${theme}.png`, fullPage: true })

  await ctx.close()
}

await browser.close()
console.log("done")
