// Settings → Relay: pair a phone with this computer and see the current state.
//
// Everything server-side comes through ~/lib/relayApi (no fetch here), and the
// section only calls it when the app is genuinely connected to a live server —
// demo/offline renders an explanation and stays silent.
//
// There is no unpair control: the hosted relay protocol has no targeted
// revocation, so offering one would be a lie.
import { CheckCircle2, Loader2, Smartphone } from "lucide-react"
import { getRelayStatus } from "~/lib/relayApi"
import { formatCountdown, secondsUntilExpiry } from "~/lib/relayPairing"
import { Button } from "../ui/button"
import { Badge, Card, EmptyNote, ErrorNote, InlineError, Loading, SectionShell, SubLabel, useAsync } from "./common"
import { QrCode } from "./QrCode"
import { useRelayPairing } from "./useRelayPairing"

/** Same shape GeneralSection takes; inlined to avoid importing back into
 *  SettingsCenter (which imports this file). */
export interface RelayConnectionInfo {
  state: string
  baseUrl: string
  workspace: string
  sessionCount: number
  mode: "live" | "demo"
}

export function RelaySection({ connection }: { connection?: RelayConnectionInfo }) {
  // Only a live, connected server can answer the relay routes. Anything else
  // (demo data, booting, reconnecting, offline) must not issue a request.
  const reachable = connection?.mode === "live" && connection.state === "connected"

  const status = useAsync(
    () => (reachable ? getRelayStatus() : Promise.resolve(null)),
    [reachable],
  )
  // `reachable` gates the hook itself: it never begins or polls while the app
  // is in demo mode or disconnected, and drops any live pairing (QR included)
  // the moment connectivity goes away.
  const pairing = useRelayPairing(reachable, status.reload)

  const relay = status.data
  const paired = relay?.paired === true
  // Worth saying whether or not a phone is paired: with the uplink off,
  // pairing still completes but nothing can reach this computer until the
  // server restarts, and the user should know that BEFORE they scan.
  const uplinkOff = relay?.enabled === false
  const busy = pairing.state.phase === "starting" || pairing.state.phase === "waiting"

  return (
    <SectionShell
      title="Relay"
      description="Pair a phone to reach this computer from the Chunky mobile app. Traffic is end-to-end encrypted; the relay only ever sees ciphertext."
    >
      {!reachable ? (
        <Card>
          <SubLabel>Status</SubLabel>
          <EmptyNote>
            {connection?.mode === "demo"
              ? "Relay pairing needs a live Chunky server. This window is showing demo data."
              : "Relay pairing is unavailable until the app is connected to your Chunky server."}
          </EmptyNote>
        </Card>
      ) : (
        <>
          <Card>
            <SubLabel>Status</SubLabel>
            {status.loading && !relay ? (
              <Loading rows={2} />
            ) : status.error ? (
              <ErrorNote message={status.error} onRetry={status.reload} />
            ) : (
              <div className="flex flex-col gap-2 pt-0.5">
                <div className="flex items-center gap-2">
                  <Badge tone={paired ? "success" : "muted"}>
                    {paired ? "Paired" : "Not paired"}
                  </Badge>
                  {uplinkOff && <Badge tone="warning">Uplink disabled</Badge>}
                </div>

                {relay?.relayUrl && (
                  <span className="break-all text-[12px] text-muted-foreground">
                    Relay · {relay.relayUrl}
                  </span>
                )}

                {paired && (relay?.peers.length ?? 0) > 0 && (
                  <ul className="flex flex-col gap-1 pt-0.5">
                    {relay?.peers.map((peer) => (
                      <li key={peer.deviceId || peer.name} className="flex items-center gap-2 text-[12.5px]">
                        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{peer.name}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {!paired && (
                  <p className="text-[12px] text-muted-foreground">
                    No phone is paired with this computer yet.
                  </p>
                )}

                {uplinkOff && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-300">
                    The relay uplink is switched off because the server started with{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">CHUNKY_RELAY=0</code>.{" "}
                    {paired
                      ? "Phones can't reach this computer"
                      : "Pairing will finish, but phones still won't reach this computer"}{" "}
                    until the server restarts without that variable.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card>
            <SubLabel>Pair a phone</SubLabel>

            {pairing.state.phase === "waiting" && pairing.state.qrPayload ? (
              <div className="flex flex-col items-center gap-3 pt-1">
                {/* Bounded width gives the (fluid) QR a definite basis and
                    keeps the plate inside the card on a narrow dialog. */}
                <div className="w-full max-w-[312px] rounded-xl border border-border bg-white p-3">
                  <QrCode
                    value={pairing.state.qrPayload}
                    size={288}
                    label="Pairing QR code for the Chunky phone app"
                  />
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                  <p className="text-[12.5px] text-foreground">
                    Scan this with the Chunky app on your phone to pair it with{" "}
                    <span className="font-medium">{pairing.state.name}</span>.
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">
                    The code is single-use and expires in{" "}
                    <span className="font-mono">
                      {formatCountdown(secondsUntilExpiry(pairing.state.expiresAt, pairing.now))}
                    </span>
                    . Keep this window open until your phone confirms.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  {/* Announced once when it appears; the per-second countdown
                      above is deliberately OUTSIDE the live region. */}
                  <span aria-live="polite" className="text-[12px] text-muted-foreground">
                    Waiting for your phone…
                  </span>
                  <Button variant="ghost" size="sm" onClick={pairing.reset}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : pairing.state.phase === "claimed" ? (
              <div className="flex flex-col gap-2 pt-0.5">
                {/* Success is otherwise a silent swap for a screen reader. */}
                <div aria-live="polite" className="flex items-center gap-2 text-[12.5px]">
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                  <span>
                    Paired with{" "}
                    <span className="font-medium">{pairing.state.peer?.name ?? "your phone"}</span>. This
                    computer is reachable from the app now.
                  </span>
                </div>
                <div>
                  <Button variant="secondary" size="sm" onClick={pairing.reset}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 pt-0.5">
                <p className="text-[12px] text-muted-foreground">
                  {paired
                    ? "A phone is already paired with this computer."
                    : "Generates a single-use QR code to scan with the Chunky phone app."}
                </p>

                <div aria-live="polite">
                  {pairing.state.phase === "expired" && (
                    <p className="text-[12px] text-amber-700 dark:text-amber-300">
                      That pairing code expired before a phone scanned it.
                    </p>
                  )}
                  {pairing.state.phase === "error" && pairing.state.error && (
                    <InlineError>{pairing.state.error}</InlineError>
                  )}
                </div>

                <div>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={paired || busy || status.loading}
                    onClick={pairing.start}
                  >
                    {pairing.state.phase === "starting" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Smartphone className="size-3.5" />
                    )}
                    {pairing.state.phase === "starting"
                      ? "Starting…"
                      : pairing.state.phase === "expired" || pairing.state.phase === "error"
                        ? "Try again"
                        : "Pair a phone"}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </SectionShell>
  )
}
