// Projects and conversations: where Mochi's chat runs, which old conversation
// to pick up, or a new one. Both lists come from Claude Code's own history, so
// sessions started in a terminal or in VS Code show up here too.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State, type ChatProject, type ChatSession } from "../core/state";
import { newConversation, openConversation, projectDot } from "./chat";
import type { ViewActions, ViewHost } from "./views";

/** Coming back to the view after this long reads the lists again. */
const RELOAD_AFTER_MS = 5000;

function ago(ms: number): string {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function message(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

export function buildSessions(actions: ViewActions): ViewHost {
  const projectList = h("div", { class: "sess-projects" });
  const head = h("div", { class: "sess-head" });
  const list = h("div", { class: "sess-list" });

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash sess-card" },
      h(
        "div",
        { class: "sess-body" },
        h("div", { class: "sess-col left" }, h("div", { class: "sess-label", text: "Projects" }), projectList),
        h("div", { class: "sess-col right" }, head, list),
      ),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.38)");

  let projects: ChatProject[] = [];
  /** The project being browsed — the chat only moves there once a conversation is picked. */
  let selected: string | null = null;
  let sessions: ChatSession[] = [];
  let loadedAt = -Infinity;
  let loading = false;
  let opening = false;
  let error: string | null = null;
  let renderedKey = "";

  async function load() {
    loading = true;
    error = null;
    render();
    try {
      projects = await Bridge.chatProjects();
      const current = State.chatProject?.path ?? projects.find((p) => p.isDefault)?.path ?? null;
      if (!selected || !projects.some((p) => p.path === selected)) selected = current;
      sessions = selected ? await Bridge.chatSessions(selected) : [];
    } catch (err) {
      error = message(err);
    }
    loading = false;
    loadedAt = performance.now();
    render();
  }

  async function select(project: ChatProject) {
    if (selected === project.path) return;
    actions.blip();
    selected = project.path;
    sessions = [];
    error = null;
    render();
    list.scrollTop = 0;
    try {
      const found = await Bridge.chatSessions(project.path);
      if (selected === project.path) sessions = found;
    } catch (err) {
      error = message(err);
    }
    render();
  }

  /** Opens a conversation (or a new one) and goes back to the chat. */
  async function go(task: () => Promise<void>) {
    if (opening || State.chatPending) return;
    opening = true;
    actions.blip();
    try {
      await task();
      actions.setView("prompt");
    } catch (err) {
      error = message(err);
      render();
    } finally {
      opening = false;
    }
  }

  function render() {
    renderedKey = `${State.chatPending}|${State.chatSessionId}|${State.usesClaudeCode}`;
    // Rebuilding must not throw the user back to the top of a list they scrolled.
    const scroll = { projects: projectList.scrollTop, list: list.scrollTop };
    fill();
    projectList.scrollTop = scroll.projects;
    list.scrollTop = scroll.list;
  }

  function fill() {
    clear(projectList);
    for (const p of projects) {
      const row = h(
        "button",
        { class: "sess-proj", title: p.path, onclick: () => void select(p) },
        projectDot(p),
        h("span", { class: "n", text: p.name }),
        p.sessions ? h("span", { class: "c", text: String(p.sessions) }) : null,
      );
      row.classList.toggle("on", p.path === selected);
      projectList.append(row);
    }

    const current = projects.find((p) => p.path === selected) ?? null;
    clear(head);
    if (current) {
      const start = h(
        "button",
        { class: "btn primary sess-new", onclick: () => void go(() => newConversation(current)) },
        svg(ICONS.compose, 11),
        h("span", { text: "New conversation" }),
      );
      start.toggleAttribute("disabled", State.chatPending);
      head.append(projectDot(current, 8), h("span", { class: "n", text: current.name }), h("div", { class: "grow" }), start);
    }

    clear(list);
    const note = (text: string, cls = "") => list.append(h("div", { class: `sess-empty ${cls}`, text }));
    if (!State.usesClaudeCode) {
      note("Conversations live in Claude Code. Switch the chat to your Claude subscription in Settings to use them.");
      return;
    }
    if (error) note(error, "err");
    if (State.chatPending) note("Mochi is still answering — wait, or stop it from the chat.");
    if (loading && projects.length === 0) {
      note("Loading…");
      return;
    }
    if (!error && sessions.length === 0 && current) {
      note(current.isDefault ? "No conversation yet. Start one!" : "No conversation in this project yet.");
    }
    for (const s of sessions) {
      const row = h(
        "button",
        {
          class: "sess-row",
          title: s.title,
          onclick: () => {
            if (current) void go(() => openConversation(current, s));
          },
        },
        h("span", { class: "t", text: s.title }),
        h("span", { class: "a", text: ago(s.updated) }),
      );
      row.classList.toggle("on", s.id === State.chatSessionId);
      list.append(row);
    }
  }

  return {
    el,
    show() {
      // Sessions started elsewhere since last time should be there.
      if (!loading && State.usesClaudeCode && performance.now() - loadedAt > RELOAD_AFTER_MS) {
        void load();
      }
    },
    sync() {
      const key = `${State.chatPending}|${State.chatSessionId}|${State.usesClaudeCode}`;
      if (key !== renderedKey) render();
    },
  };
}
