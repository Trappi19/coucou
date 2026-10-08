// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, plus the project bar of Claude Code conversations.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { colorForProject } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type ChatMessage, type ChatProject, type ChatSession } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

let nextId = 1;

const TITLE_MAX = 60;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const cls = message.role === "error" ? "reply err" : "reply";
  return h("div", { class: "chat-row" }, h("div", { class: cls, text: message.content }));
}

// ── The answer being written ─────────────────────────────────────────────────

/** Fade of each newly shown piece of text (style.css, `.reply .fresh`). */
const FADE_MS = 350;
/** Longest the end of an answer may take to show before it is put in whole. */
const FINISH_MAX_MS = 4000;

/**
 * The reply as it arrives, shown a little behind the text received so the
 * words flow in evenly instead of in bursts: each frame reveals a share of
 * what is waiting, and every new piece fades in. Runs only while there is
 * text left to show.
 */
class LiveReply {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private target = "";
  private shown = 0;
  private raf = 0;
  private last = 0;
  private final = false;
  private done: (() => void) | null = null;
  /** The view redraws its log when the live bubble appears or goes. */
  onPresence: () => void = () => {};

  constructor() {
    this.body = h("div", { class: "reply" });
    this.el = h("div", { class: "chat-row" }, this.body);
  }

  get active(): boolean {
    return this.target.length > 0;
  }

  /** Called by the log after it has scrolled, to keep following the text. */
  follow: () => void = () => {};

  append(text: string) {
    if (this.final) return;
    const was = this.active;
    // Leading blank lines would show as an empty bubble.
    this.target = this.target ? this.target + text : text.trimStart();
    if (this.active !== was) this.onPresence();
    this.run();
  }

  reset() {
    const was = this.active;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = "";
    this.shown = 0;
    this.final = false;
    this.done?.();
    this.done = null;
    clear(this.body);
    if (was) this.onPresence();
  }

  /** The whole answer is known: show the rest of it, resolve once it is on screen. */
  finish(text: string): Promise<void> {
    const sofar = this.target.slice(0, Math.floor(this.shown));
    if (!text.startsWith(sofar)) {
      clear(this.body);
      this.shown = 0;
    }
    const was = this.active;
    this.target = text;
    this.final = true;
    if (this.active !== was) this.onPresence();
    return new Promise((resolve) => {
      // Frames can stop coming (the webview throttles a window it thinks is
      // out of sight): the answer must land in the conversation regardless.
      const deadline = window.setTimeout(() => settle(), FINISH_MAX_MS);
      const settle = () => {
        window.clearTimeout(deadline);
        if (this.done === settle) this.done = null;
        resolve();
      };
      this.done = settle;
      this.run();
    });
  }

  private run() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.step);
  }

  private step = (now: number) => {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const backlog = this.target.length - this.shown;
    if (backlog <= 0) {
      this.raf = 0;
      if (this.final && this.done) {
        const done = this.done;
        this.done = null;
        // Let the last piece finish fading before the bubble is replaced.
        window.setTimeout(done, FADE_MS);
      }
      return;
    }
    // Fast when far behind, never slower than ~90 characters a second; quicker
    // still once the answer is complete.
    const share = this.final ? 0.12 : 0.06;
    const next = Math.min(this.target.length, this.shown + Math.max(backlog * share, 1.5) * (dt / 16.7));
    const from = Math.floor(this.shown);
    let to = Math.floor(next);
    // Never split an emoji (a surrogate pair) across two pieces.
    const code = this.target.charCodeAt(to - 1);
    if (to < this.target.length && code >= 0xd800 && code <= 0xdbff) to++;
    if (to > from) {
      this.body.append(h("span", { class: "fresh", text: this.target.slice(from, to) }));
      this.follow();
    }
    this.shown = Math.max(next, to);
    this.raf = requestAnimationFrame(this.step);
  };
}

const live = new LiveReply();

/** A piece of the answer from Claude Code (main.ts, "chat-delta"). */
export function streamReply(delta: { text: string; reset: boolean }) {
  if (!State.chatPending) return;
  if (delta.reset) live.reset();
  else live.append(delta.text);
}

/** The dots, and what Claude Code is busy with when it says so. */
function typingDots(label: string | null): HTMLElement {
  return h(
    "div",
    { class: "chat-row typing-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
    label ? h("span", { class: "typing-label shimmer", text: label }) : null,
  );
}

/**
 * The coloured chip showing what the question is about (a dropped file).
 * `onRemove` adds the × — only offered while the file hasn't gone out yet.
 */
function contextChip(label: string, onRemove: (() => void) | null): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  if (onRemove) {
    chip.title = "Sent to Claude with your first message";
    chip.append(
      h(
        "button",
        { class: "chip-x", title: "Leave this file out", onclick: () => onRemove() },
        svg(ICONS.xmark, 7),
      ),
    );
  } else {
    chip.title = "Claude has this file in this conversation. Start a new one to leave it out.";
  }
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

/** A fresh conversation about a dropped file: the file stays, everything else goes. */
export async function newConversationAbout(file: { name: string; path: string }): Promise<void> {
  // An answer still coming in belongs to the old conversation: stop it first.
  if (State.chatPending) {
    await Bridge.chatCancel();
    for (let i = 0; i < 50 && State.chatPending; i++) await new Promise((r) => setTimeout(r, 100));
  }
  await newConversation();
  State.chatDraft = "";
  State.droppedFile = file;
  State.promptContext = { kind: "file", name: file.name, path: file.path };
  State.notify();
}

/** Project dot: Mochi's rainbow for Discussion, the project colour otherwise. */
export function projectDot(project: ChatProject | null, size = 7): HTMLElement {
  const isDefault = project == null || project.isDefault;
  const el = h("i", { class: isDefault ? "dot chip-dot" : "dot" });
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  if (project && !project.isDefault) el.style.background = colorForProject(project.name);
  return el;
}

function shortTitle(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

/** A fresh conversation, in `project` when given, otherwise where the chat already is. */
export async function newConversation(project?: ChatProject): Promise<void> {
  if (State.chatPending) return;
  if (project && State.usesClaudeCode) {
    await Bridge.chatOpen(project.path, null);
    State.chatProject = project;
  } else {
    await Bridge.chatReset();
  }
  State.clearChat();
  State.notify();
}

/** Picks up an old Claude Code conversation where it was left. */
export async function openConversation(project: ChatProject, session: ChatSession): Promise<void> {
  if (State.chatPending) return;
  const messages = await Bridge.chatOpen(project.path, session.id);
  State.clearChat();
  State.chatProject = project;
  State.chatSessionId = session.id;
  State.chatTitle = session.title;
  State.chatHistory = messages.map((m) => ({ id: nextId++, role: m.role, content: m.content }));
  State.notify();
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const projectName = h("span", { class: "proj-name" });
  const projectDotSlot = h("span", { class: "proj-dot" });
  const projectBtn = h(
    "button",
    {
      class: "proj-btn",
      title: "Projects and conversations",
      onclick: () => {
        actions.blip();
        actions.setView("sessions");
      },
    },
    projectDotSlot,
    projectName,
    svg(ICONS.chevronDown, 8, { stroke: 2.6 }),
  );
  const title = h("span", { class: "chat-title" });
  const newBtn = h(
    "button",
    { class: "chat-icon-btn", title: "New conversation", onclick: () => void startNew() },
    svg(ICONS.compose, 12),
  );
  const top = h("div", { class: "chat-top" }, projectBtn, title, h("div", { class: "grow" }), newBtn);

  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, top, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let renderedKey = "";
  let projectKey = "";

  /** Following the answer down, unless the user scrolled up to read. */
  let stickToBottom = true;
  log.addEventListener("scroll", () => {
    stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  });
  live.follow = () => {
    if (stickToBottom) log.scrollTop = log.scrollHeight;
  };
  live.onPresence = () => State.notify();
  let sendMode: "send" | "stop" = "send";

  async function startNew() {
    if (State.chatPending) return;
    actions.blip();
    await newConversation();
    input.value = "";
    State.chatDraft = "";
    onHeightChange();
    input.focus();
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || State.chatPending) return;
    input.value = "";
    State.chatDraft = "";
    Sound.play("send");

    const first = !State.chatHistory.some((m) => m.role !== "error");
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    if (!State.chatTitle) State.chatTitle = shortTitle(query);
    State.chatPending = true;
    State.chatActivity = null;
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      first && file ? { kind: "file", name: file.name, path: file.path } : null;

    live.reset();
    try {
      const reply = await Bridge.chatSend(query, context);
      if (reply.sessionId) State.chatSessionId = reply.sessionId;
      Sound.play("finish");
      // The end of the answer flows in like the rest (all of it, from the API).
      await live.finish(reply.text);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
    } catch (err) {
      const message = String(err).replace(/^Error:\s*/, "");
      if (message === "Stopped.") {
        Sound.play("blip");
      } else {
        State.chatHistory.push({ id: nextId++, role: "error", content: message });
        Sound.play("error");
      }
    } finally {
      live.reset();
      State.chatPending = false;
      State.chatActivity = null;
      State.stateOverride = null;
      State.notify();
      onHeightChange();
      if (State.view === "prompt") input.focus();
    }
  }

  send.addEventListener("click", () => {
    if (sendMode === "stop") {
      actions.blip();
      void Bridge.chatCancel();
    } else {
      void submit();
    }
  });
  input.addEventListener("input", () => {
    State.chatDraft = input.value;
  });
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape") {
      e.preventDefault();
      actions.collapse();
    }
    // Keys typed here are for the field, not the island's own shortcuts.
    e.stopPropagation();
  });

  return {
    el,
    keyboard: true,
    sync() {
      const claudeCode = State.usesClaudeCode;
      projectBtn.style.display = claudeCode ? "" : "none";
      const project = State.chatProject;
      const pKey = `${project?.path ?? ""}|${claudeCode}`;
      if (pKey !== projectKey) {
        projectKey = pKey;
        projectName.textContent = project?.name ?? "Discussion";
        clear(projectDotSlot);
        projectDotSlot.append(projectDot(project));
      }
      title.textContent =
        State.chatTitle ?? (State.chatHistory.length === 0 ? "New conversation" : "");
      newBtn.disabled = State.chatPending;

      // The file goes out with the first message only: until then it can be left out.
      const file = State.droppedFile;
      const removable = file != null && !State.chatHistory.some((m) => m.role === "user");
      const wantChip = file ? `${file.name}|${removable}` : "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (file) {
          chipRow.append(
            contextChip(file.name, removable ? () => {
              actions.blip();
              State.droppedFile = null;
              State.promptContext = null;
              State.notify();
              input.focus();
            } : null),
          );
        }
      }

      const pending = State.chatPending;
      const key = [
        State.chatHistory.at(-1)?.id ?? 0,
        State.chatHistory.length,
        pending,
        State.chatActivity ?? "",
        live.active,
      ].join("|");
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        // The answer being written takes the place of the dots.
        if (live.active) log.append(live.el);
        else if (pending) log.append(typingDots(State.chatActivity));
        log.scrollTop = log.scrollHeight;
        stickToBottom = true;
      }

      // Claude Code and local turns can be stopped; an API call just has to finish.
      const canStop = State.chatCanStop;
      const mode = pending && canStop ? "stop" : "send";
      if (mode !== sendMode) {
        sendMode = mode;
        clear(send);
        send.append(mode === "stop" ? svg(ICONS.stop, 10) : svg(ICONS.arrowUp, 11));
        send.title = mode === "stop" ? "Stop" : "Send";
      }
      send.disabled = pending && !canStop;

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      if (input.value !== State.chatDraft && document.activeElement !== input) {
        input.value = State.chatDraft;
      }
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
