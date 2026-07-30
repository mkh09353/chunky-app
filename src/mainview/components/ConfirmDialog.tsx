// The UI half of lib/confirm.ts: one host mounted at the app root that renders
// whichever confirmation is at the head of the queue.
//
// Keyboard contract: focus lands on the confirm button when it opens, Enter
// confirms, Escape (and the backdrop, and Cancel) cancels.
import { useRef, useSyncExternalStore } from "react"
import { currentConfirm, subscribeConfirm } from "~/lib/confirm"
import { Button } from "./ui/button"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog"

export function ConfirmHost() {
  // The server snapshot is null: nothing is ever pending during SSR/hydration.
  const request = useSyncExternalStore(subscribeConfirm, currentConfirm, () => null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={request !== null}
      // Only fires on a real dismissal (Escape / backdrop): a queued follow-up
      // keeps `open` true, so answering one prompt can never cancel the next.
      onOpenChange={(open) => {
        if (!open) request?.settle(false)
      }}
    >
      <DialogPopup
        showClose={false}
        className="max-w-md"
        initialFocus={confirmRef}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.defaultPrevented) return
          // A focused button handles its own Enter — don't override Cancel.
          if (event.target instanceof HTMLElement && event.target.closest("button")) return
          event.preventDefault()
          request?.settle(true)
        }}
      >
        <DialogHeader>
          <DialogTitle>{request?.title ?? ""}</DialogTitle>
          {request?.body && (
            <DialogDescription className="whitespace-pre-line">{request.body}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => request?.settle(false)}>
            {request?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            ref={confirmRef}
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => request?.settle(true)}
          >
            {request?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
