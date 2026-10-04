// The catalog's save controls.
//
// The host offers exactly one message, parent to frame:
//   { type: "proton-save", action: "flush" | "reset" }
// and a reset has to be answered with `reset-done`. Two details matter. The
// reply goes to the sender when there is one, and it is sent *after* the save
// has actually been emptied and the game told — otherwise the host can race a
// debounced write and the reset quietly undoes itself.

import type { SaveStore } from "./store";

interface HostMessage {
  type?: unknown;
  action?: unknown;
}

export interface HostHooks {
  /** The save has been emptied: drop to the menu and rebuild whatever showed it. */
  onReset?: () => void;
}

export function attachHostBridge(store: SaveStore, hooks: HostHooks = {}): () => void {
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as HostMessage | null;
    if (!data || data.type !== "proton-save") return;
    if (data.action === "flush") {
      store.flush();
      return;
    }
    if (data.action === "reset") {
      store.reset();
      hooks.onReset?.();
      const reply = { type: "proton-save", action: "reset-done" };
      const target = (event.source as WindowProxy | null) ?? window.parent;
      target?.postMessage(reply, "*");
      return;
    }
    // Any other action is left alone rather than guessed at.
  };

  // Leaving is the only teardown the host gives: it navigates the frame to
  // about:blank, so this is the last chance to write.
  const onLeave = (): void => store.flush();

  window.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.flush();
  });

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pagehide", onLeave);
  };
}
