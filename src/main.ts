// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent, type UpdateInfo } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { streamReply } from "./views/chat";

/** Whether whoever answers the chat is set up, for the badge in the island's settings. */
async function refreshChatReady() {
  if (State.usesClaudeCode) {
    const cli = await Bridge.claudeCodeStatus();
    State.chatReady = (cli?.found ?? false) && (cli?.loggedIn ?? false);
  } else {
    State.chatReady = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  }
  State.notify();
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<null>("outside-click", () => island.outsideClick());

  // What Claude Code is doing during a chat turn: the line under the typing
  // dots, and Mochi searching while it is on the web.
  await onEvent<{ tool: string; label: string }>("chat-activity", ({ tool, label }) => {
    if (!State.chatPending) return;
    State.chatActivity = label;
    State.stateOverride = tool === "WebSearch" || tool === "WebFetch" ? "searching" : "thinking";
    State.notify();
  });

  // The answer as Claude Code writes it.
  await onEvent<{ text: string; reset: boolean }>("chat-delta", (delta) => streamReply(delta));

  void refreshChatReady();

  // A new local build (npm run release) landed in the updates folder.
  await onEvent<UpdateInfo | null>("update-available", (info) => {
    State.update = info ? { version: info.version, builtAt: info.builtAt } : null;
    State.notify();
    island.offerUpdate();
  });

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "updates":
        // Tray → Check for updates: the card says either way.
        void Bridge.updateStatus().then((s) => {
          State.update = s?.available ? { version: s.available.version, builtAt: s.available.builtAt } : null;
          island.alert("update");
        });
        break;
      case "resize":
        setPaused(false);
        island.startResize();
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const backendChanged = s.chatBackend !== State.settings.chatBackend;
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
    if (backendChanged) void refreshChatReady();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // One built while Coucou was closed: offer it once the greeting is over.
  const status = await Bridge.updateStatus();
  if (status?.available) {
    State.update = { version: status.available.version, builtAt: status.available.builtAt };
    window.setTimeout(() => island.offerUpdate(), 6000);
  }

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
