import { handleGlobalHotkeyKeyDownImpl } from "../../application/app/AppHandlers";
import { matchesKeyBinding } from "../../domain/models";
import { DEFAULT_KEY_BINDINGS } from "../../domain/models/keyBindings";

/**
 * Presses the default close-tab shortcut (Cmd+W on mac, Ctrl+W elsewhere) on
 * `target` through the app's capture-phase global hotkey handler, installed the
 * way AppSideEffects installs it. Reports the tab actions it ran instead of
 * closing a dialog.
 */
export function pressCloseTabShortcut(target: Element, scheme: "mac" | "pc" = "pc") {
  const view = target.ownerDocument.defaultView;
  if (!view) throw new Error("target is not attached to a window");
  const closeTab = DEFAULT_KEY_BINDINGS.find((binding) => binding.action === "closeTab");
  if (!closeTab) throw new Error("closeTab binding missing");
  const actions: string[] = [];
  const onKeyDown = (event: KeyboardEvent) => handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false,
    closeTabKeyStr: scheme === "mac" ? closeTab.mac : closeTab.pc,
    executeHotkeyAction: (action: string) => {
      actions.push(action);
    },
    hotkeyScheme: scheme,
    keyBindings: DEFAULT_KEY_BINDINGS,
    matchesKeyBinding,
  }), event);
  const event = new view.KeyboardEvent("keydown", {
    key: "w",
    code: "KeyW",
    metaKey: scheme === "mac",
    ctrlKey: scheme === "pc",
    bubbles: true,
    cancelable: true,
  });
  view.addEventListener("keydown", onKeyDown, true);
  try {
    target.dispatchEvent(event);
  } finally {
    view.removeEventListener("keydown", onKeyDown, true);
  }
  return { actions, defaultPrevented: event.defaultPrevented };
}
