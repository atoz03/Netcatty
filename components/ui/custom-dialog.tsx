import * as React from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import { getTopmostOpenDialog } from "../../application/state/dialogStack";
import { isAppLockOverlayActive } from "../../infrastructure/appLockOverlayDom";
import { cn } from "../../lib/utils";

export interface CustomDialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Escape, Cmd/Ctrl+W and the hidden close control dismiss through this. */
  onDismiss: () => void;
  /** Leave Escape to an open nested popup that is not a Radix layer, such as `Dropdown`. */
  dismissOnEscape?: boolean;
}

/**
 * The panel of a modal overlay built without Radix. It keeps the contract of
 * the shared `DialogContent` (see `application/state/dialogStack.ts`):
 * - `role="dialog"`, `aria-modal` and `data-state="open"` let terminal refocus,
 *   SFTP shortcuts and native view occlusion treat it as an open dialog;
 * - Cmd/Ctrl+W clicks its hidden `data-dialog-close` control;
 * - Escape dismisses the topmost dialog unless a nested layer handled the key;
 * - focus moves into the panel, and back to the opener when it closes.
 * Backdrop clicks stay with the caller, because some overlays must not close on them.
 */
export function CustomDialogContent({
  onDismiss,
  dismissOnEscape = true,
  className,
  children,
  ...props
}: CustomDialogContentProps) {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Read while rendering: children with autoFocus take focus when they commit.
  const [opener] = React.useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  const handleKeyDown = React.useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !dismissOnEscape) return;
    const panel = panelRef.current;
    if (!panel || getTopmostOpenDialog(panel.ownerDocument) !== panel) return;
    if (isAppLockOverlayActive(panel.ownerDocument)) return;
    event.preventDefault();
    onDismiss();
  });

  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const doc = panel.ownerDocument;
    // Bubble phase: nested Radix layers handle Escape while capturing and
    // mark it defaultPrevented, so they close before this dialog does.
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    doc.addEventListener("keydown", onKeyDown);
    // Focus never leaves the app lock screen for a dialog behind it.
    if (!isAppLockOverlayActive(doc) && !panel.contains(doc.activeElement)) {
      panel.focus({ preventScroll: true });
    }
    return () => {
      doc.removeEventListener("keydown", onKeyDown);
      // Closing detaches the panel; StrictMode re-runs effects on a live one.
      if (panel.isConnected || isAppLockOverlayActive(doc)) return;
      const active = doc.activeElement;
      if (active && active !== doc.body) return;
      const target = opener as HTMLElement | null;
      if (target && target !== doc.body && target.isConnected && typeof target.focus === "function") {
        target.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      data-state="open"
      tabIndex={-1}
      className={cn("outline-none", className)}
      {...props}
    >
      {children}
      <button
        type="button"
        data-dialog-close="true"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        {t("common.close")}
      </button>
    </div>
  );
}
