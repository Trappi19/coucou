// Global shortcuts → island actions. Rust registers the keys (shortcuts.rs) and
// sends the action id; this does the same as the matching click would.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

/** Next or previous pill: focus moves along, and the overview shows it. */
function stepPill(island: Island, by: number) {
  const tasks = State.tasks;
  if (tasks.length === 0) return;
  const at = Math.max(0, tasks.findIndex((t) => t.id === State.focusTask?.id));
  State.setFocus(tasks[(at + by + tasks.length) % tasks.length].id);
  Sound.play("blip");
  island.alert("overview");
}

export function registerShortcutHandlers(island: Island) {
  void onEvent<string>("shortcut", (action) => {
    if (State.paused || State.resizing) return;
    Sound.resume();
    switch (action) {
      case "openChat":
        island.alert("prompt");
        break;
      case "toggleIsland":
        if (State.mode === "expanded") island.collapse();
        else island.alert(State.defaultView());
        break;
      case "goToAlert": {
        // A permission waiting first, then any pill with a badge.
        if (State.pendingApproval) {
          island.alert("approval");
          break;
        }
        const flagged = State.tasks.find((t) => t.pillBadge);
        if (flagged) {
          State.setFocus(flagged.id);
          island.alert("overview");
        } else {
          Sound.play("blip");
        }
        break;
      }
      case "jumpToTerminal":
        void Bridge.openInVSCode(State.focusTask?.sessionCwd ?? null);
        break;
      case "nextPill":
        stepPill(island, 1);
        break;
      case "prevPill":
        stepPill(island, -1);
        break;
      case "muteToggle":
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        if (State.settings.soundEnabled) Sound.play("blip");
        State.notify();
        break;
      case "openNotes":
        island.alert("notes");
        break;
      case "openUsage":
        if (State.usesClaudeCode) island.alert("usage");
        break;
    }
  });
}
