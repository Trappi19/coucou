// Reminders: "remind me to … at …". Type what and when (or pick a quick time),
// and the list shows what's coming; a click on one edits it in place. When one
// is due the island opens here, the reminder at the top in amber, with Snooze
// and Done, while Mochi rings.
//
// The rows are kept from one redraw to the next, so they can move: a new one
// comes in, a snoozed one slides to its new place, a done one lifts away.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { Reminders, inLabel, parseWhen, whenLabel, type Reminder } from "../core/reminders";
import { bump, flash, leave, measure, popIn, slideFrom } from "./motion";
import type { IslandViewName } from "../core/layout";
import type { ViewActions, ViewHost } from "./views";

/** Quick times under the field, as what they type. */
const QUICK: [string, string][] = [
  ["In 10 min", "in 10 min"],
  ["In 1 h", "in 1h"],
  ["18:00", "18:00"],
  ["Tomorrow 9:00", "tomorrow 9:00"],
];

/** "Timer · Reminders": the two halves of the timer tab. */
export function timeSwitch(actions: ViewActions, current: IslandViewName): HTMLElement {
  const item = (view: IslandViewName, label: string) => {
    const b = h("button", {
      class: view === current ? "on" : "",
      onclick: () => {
        if (view === current) return;
        actions.blip();
        actions.setView(view);
      },
    }, label);
    return b;
  };
  return h("div", { class: "time-switch" }, item("timer", "Timer"), item("reminders", "Reminders"));
}

export function buildReminders(actions: ViewActions): ViewHost {
  const what = h("input", {
    class: "rm-what",
    type: "text",
    placeholder: "Remind me to…",
    maxlength: "120",
    spellcheck: "true",
  }) as HTMLInputElement;
  const when = h("input", {
    class: "rm-when",
    type: "text",
    placeholder: "When? 14:30, in 20 min…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const addBtn = h("button", { class: "btn primary rm-add", title: "Add (Enter)" }, svg(ICONS.plus, 10), h("span", { text: "Add" }));
  const preview = h("span", { class: "rm-preview" });
  const quick = h(
    "div",
    { class: "rm-quick" },
    ...QUICK.map(([label, typed]) =>
      h("button", {
        class: "rm-chip",
        onclick: () => {
          actions.blip();
          when.value = typed;
          syncPreview();
          what.focus();
        },
      }, label),
    ),
  );
  const list = h("div", { class: "rm-list" });
  const form = h(
    "div",
    { class: "rm-form" },
    h("div", { class: "rm-fields" }, what, when, addBtn),
    h("div", { class: "rm-hints" }, quick, preview),
  );

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash rm-card" },
      h("div", { class: "rm-body" }, h("div", { class: "rm-top" }, h("div", { class: "rm-title", text: "Reminders" }), timeSwitch(actions, "reminders")), form, list),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(245,165,36,0.16)");

  let listKey = "";
  let tookFocus = false;

  function syncPreview() {
    const at = parseWhen(when.value);
    preview.classList.toggle("bad", when.value.trim() !== "" && at == null);
    preview.textContent = !when.value.trim() ? "" : at == null ? "Can't read that time" : `→ ${whenLabel(at)} · ${inLabel(at)}`;
  }

  function add() {
    const at = parseWhen(when.value);
    if (!what.value.trim()) {
      what.focus();
      return;
    }
    if (at == null) {
      when.classList.add("bad");
      window.setTimeout(() => when.classList.remove("bad"), 500);
      when.focus();
      return;
    }
    const added = Reminders.add(what.value, at);
    if (!added) return;
    actions.react("add");
    bump(addBtn, 1.12);
    flashIds.add(added.id);
    what.value = "";
    when.value = "";
    syncPreview();
    what.focus();
  }

  addBtn.addEventListener("click", add);
  for (const field of [what, when]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (field === what && !when.value.trim()) when.focus();
        else add();
      }
    });
    // The keyboard only when a field is clicked: an alarm opening this view
    // must not catch what is being typed elsewhere.
    field.addEventListener("mousedown", () => {
      if (tookFocus) return;
      tookFocus = true;
      void Bridge.focusWindow(true);
    });
  }
  when.addEventListener("input", syncPreview);

  /** The rows on screen, by reminder id, with what they were drawn from. */
  const rows = new Map<string, { el: HTMLElement; sig: string }>();
  const empty = h("div", { class: "rm-empty" });
  /** How a reminder that is about to go should leave. */
  const leaving = new Map<string, "delete" | "done">();
  /** Rows to light up once drawn (just added, edited, snoozed). */
  const flashIds = new Set<string>();
  /** The first draw after the view comes up stays still. */
  let painted = false;

  // ── Editing in place ────────────────────────────────────────────────────

  let editingId: string | null = null;
  /** What the time field said when editing began: unchanged, the time is kept. */
  let editWhenStart = "";

  function takeKeyboard() {
    if (tookFocus) return;
    tookFocus = true;
    void Bridge.focusWindow(true);
  }

  function startEdit(r: Reminder) {
    if (Reminders.isRinging(r.id)) return;
    actions.blip();
    editingId = r.id;
    takeKeyboard();
    render();
    const input = rows.get(r.id)?.el.querySelector<HTMLInputElement>(".rm-edit-what");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function cancelEdit() {
    if (!editingId) return;
    editingId = null;
    render();
  }

  function shake(input: HTMLInputElement) {
    input.classList.remove("bad");
    void input.offsetWidth;
    input.classList.add("bad");
    input.focus();
  }

  function saveEdit(r: Reminder, whatInput: HTMLInputElement, whenInput: HTMLInputElement) {
    const changedWhen = whenInput.value.trim() !== editWhenStart.trim();
    const at = changedWhen ? parseWhen(whenInput.value) : r.at;
    if (!whatInput.value.trim()) return shake(whatInput);
    if (at == null) return shake(whenInput);
    editingId = null;
    flashIds.add(r.id);
    if (Reminders.update(r.id, whatInput.value, at)) actions.react("save");
    render();
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  function fillRow(el: HTMLElement, r: Reminder, mode: "ringing" | "editing" | "normal", now: number) {
    el.className = mode === "normal" ? "rm-row" : `rm-row ${mode}`;
    el.replaceChildren();
    if (mode === "ringing") {
      el.append(
        h("span", { class: "rm-bell" }, svg(ICONS.timer, 11)),
        h("span", { class: "rm-text", text: r.text, title: r.text }),
        h("span", { class: "rm-at", text: whenLabel(r.at, now) }),
        h("button", {
          class: "btn secondary rm-act",
          onclick: () => {
            actions.react("snooze");
            flashIds.add(r.id);
            Reminders.snooze(r.id, 5 * 60_000);
          },
        }, "Snooze 5 min"),
        h("button", {
          class: "btn primary rm-act",
          onclick: () => {
            actions.react("done");
            leaving.set(r.id, "done");
            Reminders.remove(r.id);
          },
        }, svg(ICONS.check, 10, { stroke: 3 }), h("span", { text: "Done" })),
      );
      return;
    }
    if (mode === "editing") {
      editWhenStart = whenLabel(r.at, now);
      const whatInput = h("input", {
        class: "rm-edit-what",
        type: "text",
        maxlength: "120",
        spellcheck: "true",
      }) as HTMLInputElement;
      whatInput.value = r.text;
      const whenInput = h("input", {
        class: "rm-edit-when",
        type: "text",
        spellcheck: "false",
        title: "14:30, in 20 min, tomorrow 9h, monday 9:00, 12/10 14:30…",
      }) as HTMLInputElement;
      whenInput.value = editWhenStart;
      const hint = h("span", { class: "rm-in" });
      const showHint = () => {
        const changed = whenInput.value.trim() !== editWhenStart.trim();
        const at = changed ? parseWhen(whenInput.value) : r.at;
        hint.classList.toggle("bad", at == null);
        hint.textContent = at == null ? "?" : inLabel(at);
      };
      showHint();
      whenInput.addEventListener("input", showHint);
      for (const input of [whatInput, whenInput]) {
        input.addEventListener("mousedown", takeKeyboard);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            saveEdit(r, whatInput, whenInput);
          } else if (e.key === "Escape") {
            // Esc leaves the edit, not the island.
            e.stopPropagation();
            cancelEdit();
          }
        });
      }
      el.append(
        whatInput,
        whenInput,
        hint,
        h("button", { class: "rm-icon save", title: "Save (Enter)", onclick: () => saveEdit(r, whatInput, whenInput) },
          svg(ICONS.check, 10, { stroke: 3 })),
        h("button", { class: "rm-icon", title: "Cancel (Esc)", onclick: () => { actions.blip(); cancelEdit(); } },
          svg(ICONS.xmark, 8)),
      );
      return;
    }
    el.append(
      h("span", { class: "rm-at", text: whenLabel(r.at, now) }),
      h("button", { class: "rm-text rm-text-btn", text: r.text, title: "Edit", onclick: () => startEdit(r) }),
      h("span", { class: "rm-in", text: inLabel(r.at, now) }),
      h("button", { class: "rm-icon rm-hover", title: "Edit", onclick: () => startEdit(r) }, svg(ICONS.compose, 10)),
      h("button", {
        class: "rm-icon rm-hover del",
        title: "Delete reminder",
        onclick: () => {
          actions.blip();
          leaving.set(r.id, "delete");
          Reminders.remove(r.id);
        },
      }, svg(ICONS.xmark, 8)),
    );
  }

  function render() {
    const now = Date.now();
    const animate = painted;
    painted = true;

    if (Reminders.status === "error") {
      for (const { el } of rows.values()) el.remove();
      rows.clear();
      empty.className = "rm-empty err";
      empty.textContent = Reminders.error ?? "";
      list.replaceChildren(empty);
      return;
    }

    const items = Reminders.list;
    // What is ringing first, then the rest, soonest first.
    const ordered = [
      ...items.filter((r) => Reminders.isRinging(r.id)),
      ...items.filter((r) => !Reminders.isRinging(r.id)),
    ];
    if (editingId && !items.some((r) => r.id === editingId)) editingId = null;

    const before = animate ? measure([...rows.values()].map((x) => x.el)) : null;

    // Gone from the list: they leave, and the others slide into their room.
    const present = new Set(ordered.map((r) => r.id));
    for (const [id, row] of rows) {
      if (present.has(id)) continue;
      rows.delete(id);
      before?.delete(row.el);
      if (animate) leave(row.el, leaving.get(id) ?? "delete");
      else row.el.remove();
      leaving.delete(id);
    }

    // In order, each row kept, and only redrawn when what it shows changed.
    let prev: Element | null = null;
    const fresh: HTMLElement[] = [];
    for (const r of ordered) {
      let row = rows.get(r.id);
      if (!row) {
        row = { el: h("div", { class: "rm-row" }), sig: "" };
        rows.set(r.id, row);
        fresh.push(row.el);
      }
      const mode = Reminders.isRinging(r.id) ? "ringing" : editingId === r.id ? "editing" : "normal";
      // While editing, a redraw would throw away what is being typed.
      const sig = mode === "editing"
        ? `editing|${r.id}`
        : `${mode}|${r.text}|${r.at}|${whenLabel(r.at, now)}|${inLabel(r.at, now)}`;
      if (sig !== row.sig) {
        fillRow(row.el, r, mode, now);
        row.sig = sig;
      }
      const slot: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
      if (slot !== row.el) list.insertBefore(row.el, slot);
      prev = row.el;
    }

    // Nothing left: say so.
    if (ordered.length === 0) {
      empty.className = "rm-empty";
      empty.textContent = Reminders.status === "loading" ? "Loading…" : "Nothing to remember yet.";
      if (!empty.isConnected) {
        list.append(empty);
        if (animate) popIn(empty, 220);
      }
    } else {
      empty.remove();
    }

    if (before) slideFrom(before);
    if (animate) fresh.forEach((el) => popIn(el));
    for (const id of flashIds) {
      const el = rows.get(id)?.el;
      if (el) flash(el);
    }
    flashIds.clear();
  }

  return {
    el,
    show() {
      listKey = "";
      painted = false;
      editingId = null;
      syncPreview();
    },
    sync() {
      // Redrawn when the list changes, and with the minute ("in 25 min").
      const minute = Math.floor(Date.now() / 60_000);
      const key = [
        Reminders.status,
        minute,
        editingId ?? "",
        ...Reminders.list.map((r) => `${r.id}:${r.at}:${Reminders.isRinging(r.id)}`),
      ].join("|");
      if (key === listKey) return;
      listKey = key;
      render();
    },
    hide() {
      editingId = null;
      const a = document.activeElement;
      if (a === what || a === when) (a as HTMLElement).blur();
      if (tookFocus) {
        tookFocus = false;
        void Bridge.focusWindow(false);
      }
    },
  };
}
