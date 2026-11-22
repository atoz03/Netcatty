/**
 * Every app dialog shares one DOM contract, so app-wide shortcuts treat the
 * Radix `DialogContent` and custom overlays (`CustomDialogContent`) alike:
 * - the open surface is `[role="dialog"][data-state="open"]`;
 * - a `[data-dialog-close="true"]` control inside it dismisses that dialog.
 *
 * Dialogs stack in document order. Portals append to `document.body` when they
 * open, so the last open dialog is the one on top.
 */
export const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"]';
export const DIALOG_CLOSE_CONTROL_SELECTOR = '[data-dialog-close="true"]';
/** Radix popovers also use `role="dialog"`; they are pickers inside a dialog, not dialogs. */
const POPOVER_SELECTOR = '[data-radix-popper-content-wrapper]';

type DialogQueryRoot = Pick<ParentNode, 'querySelectorAll'>;

const currentDocument = (): DialogQueryRoot | null =>
  typeof document !== 'undefined' ? document : null;

/** The open dialog on top of the stack, if any. Open popovers are skipped. */
export function getTopmostOpenDialog(
  root: DialogQueryRoot | null = currentDocument(),
): Element | null {
  const dialogs = root?.querySelectorAll(OPEN_DIALOG_SELECTOR) ?? [];
  for (let index = dialogs.length - 1; index >= 0; index--) {
    if (!dialogs[index].closest(POPOVER_SELECTOR)) return dialogs[index];
  }
  return null;
}

/**
 * The close control of the topmost open dialog. Cmd/Ctrl+W clicks it before it
 * closes any tab or window. A topmost dialog without one (the app lock overlay)
 * yields null; dialogs below it are never closed through it.
 */
export function getTopmostDialogCloseControl(
  root: DialogQueryRoot | null = currentDocument(),
): HTMLElement | null {
  return getTopmostOpenDialog(root)?.querySelector<HTMLElement>(DIALOG_CLOSE_CONTROL_SELECTOR) ?? null;
}
