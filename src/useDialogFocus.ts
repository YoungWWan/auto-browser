import { useEffect, useRef } from "react";

/** Keep keyboard navigation inside an open modal, then restore its trigger. */
export function useDialogFocus(open: boolean, dismiss: () => void) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  if (open && !wasOpen.current)
    returnFocus.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const dialog = document.querySelector<HTMLElement>(
      ".modal-backdrop [role='dialog']",
    );
    if (!dialog) return;
    const focusable = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex='0']",
        ),
      ].filter((element) => element.getClientRects().length > 0);
    if (!dialog.contains(document.activeElement)) focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, [open]);
}
