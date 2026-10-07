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

/** The dots, and what Claude Code is busy with when it says so. */
function typingDots(label: string | null): HTMLElement {
  return h(
    "div",
    { class: "chat-row typing-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
    label ? h("span", { class: "typing-label shimmer", text: label }) : null,
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
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

    try {
      const reply = await Bridge.chatSend(query, context);
      if (reply.sessionId) State.chatSessionId = reply.sessionId;
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      Sound.play("finish");
    } catch (err) {
      const message = String(err).replace(/^Error:\s*/, "");
      if (message === "Stopped.") {
        Sound.play("blip");
      } else {
        State.chatHistory.push({ id: nextId++, role: "error", content: message });
        Sound.play("error");
      }
    } finally {
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

      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const pending = State.chatPending;
      const key = [
        State.chatHistory.at(-1)?.id ?? 0,
        State.chatHistory.length,
        pending,
        State.chatActivity ?? "",
      ].join("|");
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (pending) log.append(typingDots(State.chatActivity));
        log.scrollTop = log.scrollHeight;
      }

      // Claude Code turns can be stopped; an API call just has to finish.
      const mode = pending && claudeCode ? "stop" : "send";
      if (mode !== sendMode) {
        sendMode = mode;
        clear(send);
        send.append(mode === "stop" ? svg(ICONS.stop, 10) : svg(ICONS.arrowUp, 11));
        send.title = mode === "stop" ? "Stop" : "Send";
      }
      send.disabled = pending && !claudeCode;

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
