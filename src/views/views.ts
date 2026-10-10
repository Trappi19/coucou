// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildNotes } from "./notes";
import { buildSessions } from "./sessions";
import { buildPlanPill, buildUsage } from "./usage";
import { buildMusic } from "./music";
import { buildTimer } from "./timer";
import { buildReminders } from "./reminders";
import { buildStopwatch } from "./stopwatch";
import { Stopwatch, chronoText } from "../core/stopwatch";
import { Timer, formatTimer } from "../core/timer";
import { buildHeaderStatus } from "./status";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type CardEntrance, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  /** Flips one of the on/off island behaviours and saves it. */
  toggleSetting(key: "openOnHover" | "foldDuringChat"): void;
  /** Resize mode: the island holds still while its size is set. */
  startResize(): void;
  /** Runs the newer local build's installer; Coucou restarts by itself. */
  installUpdate(): void;
  openSettingsWindow(): void;
  blip(): void;
  /** Mochi reacts to something done from the island, with its sound. */
  react(kind: Reaction): void;
}

/**
 * start: a timer or the stopwatch starts · add: a reminder is added · done: an
 * alarm answered, a reminder done · snooze: put off for later · save: an edit
 * kept · lap: a lap marked on the stopwatch.
 */
export type Reaction = "start" | "add" | "done" | "snooze" | "save" | "lap";

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called each time the view comes on screen. */
  show?(): void;
  /** Called when the view goes off screen, or the island folds on it. */
  hide?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** The view has text fields: the island takes keyboard focus while it is on. */
  keyboard?: boolean;
  /** In use right now (something being typed): the island must not fold by itself. */
  engaged?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const tabHistory = h("button", { class: "tab", title: "Conversations", onclick: () => go("sessions") }, svg(ICONS.clock, 13));
  const tabNotes = h("button", { class: "tab", title: "Notes", onclick: () => go("notes") }, svg(ICONS.note, 13, { stroke: 2.1 }));
  const tabMusic = h("button", { class: "tab", title: "Music", onclick: () => go("music") }, svg(ICONS.music, 13, { stroke: 2 }));
  // One tab for the timer and the reminders, back to whichever was used last.
  let timeView: IslandViewName = "timer";
  const tabTimer = h("button", { class: "tab", title: "Timer, stopwatch & reminders", onclick: () => go(timeView) }, svg(ICONS.timer, 13));
  // The stopwatch, in sight from every other view too.
  const chronoText_ = h("span");
  const chronoPill = h(
    "button",
    { class: "header-timer chrono", title: "Stopwatch", onclick: () => go("stopwatch") },
    svg(ICONS.chrono, 11, { stroke: 2.2 }),
    chronoText_,
  );
  // The countdown, in sight from every other view; a click goes to the timer.
  const timerText = h("span");
  const timerPill = h(
    "button",
    { class: "header-timer", title: "Timer", onclick: () => go("timer") },
    svg(ICONS.timer, 11),
    timerText,
  );

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  // Folds the island back to compact — the way out of a conversation, which
  // stays open while you work elsewhere.
  const foldBtn = h(
    "button",
    { title: "Minimize (Esc)", onclick: () => { actions.blip(); actions.collapse(); } },
    svg(ICONS.chevronUp, 14, { stroke: 2.4 }),
  );

  // "Claude 28%": the plan's usage, always in sight while the island is open,
  // with the battery (laptops) and the time just before it.
  const planPill = buildPlanPill(actions);
  const headerStatus = buildHeaderStatus();

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabHistory, tabNotes, tabTimer, tabMusic, tabDrop),
    h("div", { class: "header-actions" }, timerPill, chronoPill, headerStatus.el, planPill.el, gearBtn, soundBtn, foldBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      planPill.sync();
      headerStatus.sync();
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabHistory.classList.toggle("on", v === "sessions");
      tabHistory.style.display = State.usesClaudeCode ? "" : "none";
      tabNotes.classList.toggle("on", v === "notes");
      const timeTab = v === "timer" || v === "stopwatch" || v === "reminders";
      if (timeTab) timeView = v;
      tabTimer.classList.toggle("on", timeTab);
      tabTimer.classList.toggle(
        "live",
        Timer.phase === "running" || Timer.phase === "ringing" || Stopwatch.phase === "running",
      );
      const showChrono = Stopwatch.active && v !== "stopwatch" && !State.resizing;
      chronoPill.style.display = showChrono ? "" : "none";
      if (showChrono) {
        chronoText_.textContent = chronoText(Stopwatch.elapsed()).replace(/\.\d+$/, "");
        chronoPill.className = `header-timer chrono ${Stopwatch.phase}`;
      }
      const showTimer = Timer.active && v !== "timer" && !State.resizing;
      timerPill.style.display = showTimer ? "" : "none";
      if (showTimer) {
        timerText.textContent = formatTimer(Timer.remaining());
        timerPill.className = `header-timer ${Timer.phase}`;
      }
      tabMusic.classList.toggle("on", v === "music");
      tabMusic.style.display = State.settings.musicWidget ? "" : "none";
      // A little dot on the tab while something plays.
      tabMusic.classList.toggle("live", State.media?.playing === true);
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : State.resizing ? "0.3" : "1";
      // Nothing to navigate to until the size is validated or cancelled.
      el.style.pointerEvents = State.resizing ? "none" : "";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  /** Which card (pill + detail or not) was last drawn, to tell an entrance from a refresh. */
  let cardIdentity = "";
  let entrance: CardEntrance = "fade";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    get entrance() {
      return entrance;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    show() {
      // Each time the island opens on the overview, the card comes in again
      // (on the next frame: show() runs after this view's sync).
      cardKey = "";
      cardIdentity = "";
      State.notify();
    },
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          // New numbers for the card already there: swapped in quietly. Another
          // card, or its detail opening or closing: it comes in, sliding the way
          // the user is going.
          const identity = `${task.id}|${detailOpen}`;
          entrance = identity === cardIdentity ? "none"
            : cardIdentity.startsWith(`${task.id}|`) ? (detailOpen ? "forward" : "back")
            : "fade";
          cardIdentity = identity;
          const cardEl = renderIntegrationCard(task, hooks);
          if (entrance !== "none") cardEl.classList.add(`enter-${entrance}`);
          clear(leftBody);
          leftBody.append(cardEl);
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  // 0 = fold the moment the mouse leaves the island.
  const autoCloseSteps = [0, 5, 15, 30];
  const segButtons = autoCloseSteps.map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });
  // Only there when a newer local build is waiting.
  const updateLink = h("button", {
    class: "link-btn",
    style: "color:#34d399;font-size:11.5px",
    onclick: () => actions.setView("update"),
  });
  const hoverSwitch = h("button", { class: "switch", onclick: () => actions.toggleSetting("openOnHover") });
  const chatFoldSwitch = h("button", { class: "switch", onclick: () => actions.toggleSetting("foldDuringChat") });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row", style: "gap:10px" },
      hoverSwitch,
      h("span", { text: "Open on hover", title: "Rest the cursor on Mochi to open it, no click needed" }),
      h("div", { style: "width:14px" }),
      chatFoldSwitch,
      h("span", { text: "Fold during chats", title: "A conversation or a note being written folds too (timer, click elsewhere). Otherwise use ⌃ or Esc" }),
    ),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      updateLink,
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Size…",
        title: "Make the island bigger or smaller",
        onclick: () => actions.startResize(),
      }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      hoverSwitch.classList.toggle("on", s.openOnHover);
      updateLink.textContent = State.update ? `Update ${State.update.version}` : "";
      updateLink.style.display = State.update ? "" : "none";
      chatFoldSwitch.classList.toggle("on", s.foldDuringChat);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      const seconds = Math.round(s.autoCloseInterval);
      autoLabel.textContent = seconds === 0 ? "Auto-close · instant" : `Auto-close · ${seconds}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === autoCloseSteps[i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(
        dot(State.chatReady ? "#22C55E" : "#F4505E", 6),
        h("span", {
          text: State.usesClaudeCode ? "Chat · Claude plan"
            : State.settings.chatBackend === "local" ? "Chat · local model" : "Chat · API",
        }),
      );
    },
  };
}

// ── Resize ────────────────────────────────────────────────────────────────────

function buildResize(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Drag an edge to resize Mochi." }),
    h("div", { class: "sub", text: "Both sides move together, so it stays centred. ✓ to keep it." }),
  );
  return { el: h("div", { class: "view" }, card("indigo", body)), sync() {} };
}

// ── Update ────────────────────────────────────────────────────────────────────

function buildUpdate(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const install = btn("Install", "primary", () => actions.installUpdate());
  const row = h("div", { class: "actions" }, install, btn("Later", "secondary", () => actions.collapse()));
  const el = h("div", { class: "view" }, card("green", stack(116, 16, title, sub, row)));
  return {
    el,
    sync() {
      const u = State.update;
      title.textContent = u ? `Coucou ${u.version} is ready.` : "Coucou is up to date.";
      const built = u?.builtAt ? new Date(u.builtAt) : null;
      const when = built && !Number.isNaN(built.getTime())
        ? `Built ${built.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. `
        : "";
      sub.textContent = u
        ? `${when}Installs in a few seconds, then Mochi comes back. Nothing else changes.`
        : "Run npm run release to build a new version.";
      install.style.display = u ? "" : "none";
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("resize", buildResize());
  map.set("update", buildUpdate(actions));
  map.set("usage", buildUsage());
  map.set("music", buildMusic());
  map.set("prompt", buildPrompt(actions, onChatHeightChange));
  map.set("sessions", buildSessions(actions));
  map.set("notes", buildNotes(actions));
  map.set("timer", buildTimer(actions));
  map.set("reminders", buildReminders(actions));
  map.set("stopwatch", buildStopwatch(actions, onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
