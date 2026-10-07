// Notes: local rich-text notes, filed in folders and tagged. The left column
// picks what to show (all notes, a folder, a tag) and lists it; the right one
// edits the note. Everything is saved to notes.json as you type.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { ago } from "./sessions";
import { applyFormat, enhanceEditor, isActive, plainText, sanitizeHtml, type FormatCommand } from "./richtext";
import { Notes, cleanTag, type Note } from "../core/notes";
import type { ViewActions, ViewHost } from "./views";

type Filter = { kind: "all" } | { kind: "folder"; name: string } | { kind: "tag"; name: string };

/** Seconds the delete button waits for its second click. */
const CONFIRM_MS = 3000;

/** Lower case, accents dropped: "Été" finds "ete". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function buildNotes(actions: ViewActions): ViewHost {
  // ── Left column: filter, search, list ─────────────────────────────────────
  const filterBtn = h("button", { class: "notes-filter", title: "Show a folder or a tag" });
  const newBtn = h(
    "button",
    { class: "notes-icon-btn", title: "New note", onclick: () => newNote() },
    svg(ICONS.compose, 12),
  );
  const search = h("input", {
    class: "notes-search",
    type: "text",
    placeholder: "Search",
    spellcheck: "false",
    oninput: () => renderList(),
  }) as HTMLInputElement;
  const list = h("div", { class: "notes-list" });
  const filterMenu = h("div", { class: "notes-menu filter-menu" });
  const side = h(
    "div",
    { class: "notes-side" },
    h("div", { class: "notes-side-head" }, filterBtn, newBtn),
    h("label", { class: "notes-search-box" }, svg(ICONS.search, 11, { stroke: 2 }), search),
    list,
    filterMenu,
  );

  // ── Right column: the note ────────────────────────────────────────────────
  const title = h("input", {
    class: "notes-title",
    type: "text",
    placeholder: "Title",
    maxlength: "120",
    spellcheck: "false",
  }) as HTMLInputElement;
  const status = h("span", { class: "notes-status" });
  const deleteBtn = h("button", { class: "notes-icon-btn danger", title: "Delete note" }, svg(ICONS.trash, 12, { stroke: 1.9 }));
  const folderChip = h("button", { class: "notes-chip folder", title: "Move to a folder" });
  const tagsEl = h("div", { class: "notes-tags" });
  const folderMenu = h("div", { class: "notes-menu folder-menu" });
  const meta = h("div", { class: "notes-meta" }, folderChip, tagsEl, folderMenu);

  const tools: [FormatCommand, Node | string, string][] = [
    ["bold", "B", "Bold (Ctrl+B)"],
    ["italic", "I", "Italic (Ctrl+I)"],
    ["underline", "U", "Underline (Ctrl+U)"],
    ["strikeThrough", "S", "Strikethrough (Ctrl+Shift+X)"],
    ["heading", "H", "Heading (# then space)"],
    ["bullets", svg(ICONS.listBullet, 13, { stroke: 2.2 }), "Bulleted list (- then space)"],
    ["numbers", "1.", "Numbered list (1. then space)"],
    ["checklist", svg(ICONS.checklist, 13, { stroke: 2 }), "Checklist ([] then space)"],
  ];
  const toolButtons = tools.map(([cmd, label, tip]) => {
    const b = h("button", { class: `notes-tool t-${cmd}`, title: tip }, label);
    // Keep the caret in the note: a button that takes focus loses the selection.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (!current()) return;
      applyFormat(editor, cmd);
      syncTools();
    });
    return { cmd, b };
  });
  const toolbar = h("div", { class: "notes-toolbar" }, ...toolButtons.map((t) => t.b));

  const editor = h("div", {
    class: "note-editor",
    contenteditable: "true",
    spellcheck: "true",
    "data-placeholder": "Write something…",
  });

  const noteEl = h(
    "div",
    { class: "notes-note" },
    h("div", { class: "notes-title-row" }, title, status, deleteBtn),
    meta,
    toolbar,
    editor,
  );
  const emptyEl = h("div", { class: "notes-empty" });
  const main = h("div", { class: "notes-main" }, noteEl, emptyEl);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash notes-card" }, h("div", { class: "notes-body" }, side, main)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(245,165,36,0.22)");

  // ── State ─────────────────────────────────────────────────────────────────
  let filter: Filter = { kind: "all" };
  let selectedId: string | null = null;
  /** The note whose content is in the editor right now. */
  let loadedId: string | null = null;
  /** Something was typed since the view came up: from then on it holds the island open. */
  let touched = false;
  let confirmTimer: number | null = null;
  const textCache = new Map<string, { html: string; text: string }>();

  function current(): Note | null {
    return Notes.get(selectedId);
  }

  function textOf(note: Note): string {
    const hit = textCache.get(note.id);
    if (hit && hit.html === note.html) return hit.text;
    const text = plainText(note.html);
    textCache.set(note.id, { html: note.html, text });
    return text;
  }

  function displayTitle(note: Note): string {
    return note.title.trim() || textOf(note).slice(0, 60) || "New note";
  }

  function matchesFilter(note: Note, f: Filter): boolean {
    if (f.kind === "folder") return note.folder === f.name;
    if (f.kind === "tag") return note.tags.includes(f.name);
    return true;
  }

  function visibleNotes(): Note[] {
    const q = fold(search.value.trim());
    return Notes.notes
      .filter((n) => matchesFilter(n, filter))
      .filter((n) => !q || fold(`${n.title} ${textOf(n)} ${n.tags.join(" ")} ${n.folder ?? ""}`).includes(q))
      .sort((a, b) => b.updated - a.updated);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function select(id: string | null) {
    if (id === selectedId && id === loadedId) return;
    selectedId = id;
    resetDelete();
    closeMenus();
    renderAll();
  }

  function newNote() {
    if (Notes.status !== "ready") return;
    actions.blip();
    const note = Notes.create(
      filter.kind === "folder" ? filter.name : null,
      filter.kind === "tag" ? [filter.name] : [],
    );
    search.value = "";
    touched = true;
    select(note.id);
    title.focus();
  }

  function setFilter(f: Filter) {
    filter = f;
    closeMenus();
    const visible = visibleNotes();
    const keep = visible.some((n) => n.id === selectedId);
    select(keep ? selectedId : visible[0]?.id ?? null);
    renderAll();
  }

  function commitEditor() {
    const note = current();
    if (!note || loadedId !== note.id) return;
    const html = sanitizeHtml(editor.innerHTML);
    if (html !== note.html) Notes.update(note.id, { html });
  }

  function resetDelete() {
    if (confirmTimer != null) window.clearTimeout(confirmTimer);
    confirmTimer = null;
    deleteBtn.classList.remove("confirm");
    deleteBtn.title = "Delete note";
  }

  deleteBtn.addEventListener("click", () => {
    const note = current();
    if (!note) return;
    if (!deleteBtn.classList.contains("confirm")) {
      // Two clicks: a note is gone for good once deleted.
      deleteBtn.classList.add("confirm");
      deleteBtn.title = "Click again to delete";
      confirmTimer = window.setTimeout(resetDelete, CONFIRM_MS);
      return;
    }
    resetDelete();
    actions.blip();
    const visible = visibleNotes();
    const i = visible.findIndex((n) => n.id === note.id);
    const next = visible[i + 1] ?? visible[i - 1] ?? null;
    Notes.remove(note.id);
    select(next?.id ?? null);
  });

  title.addEventListener("input", () => {
    const note = current();
    if (!note) return;
    touched = true;
    Notes.update(note.id, { title: title.value });
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      placeCaretAtEnd(editor);
    }
  });

  enhanceEditor(editor, () => {
    // An emptied field keeps a stray <br>; drop it so the placeholder comes back.
    if (editor.innerHTML === "<br>") editor.innerHTML = "";
    touched = true;
    commitEditor();
    syncTools();
  });
  editor.addEventListener("blur", () => commitEditor());
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === editor) syncTools();
  });

  // ── Menus ─────────────────────────────────────────────────────────────────

  function closeMenus() {
    filterMenu.classList.remove("open");
    folderMenu.classList.remove("open");
  }

  function menuItem(
    label: string,
    opts: { on?: boolean; count?: number; icon?: Node; onClick: () => void; remove?: () => void; removeTitle?: string },
  ): HTMLElement {
    const row = h(
      "button",
      { class: "notes-menu-item", onclick: opts.onClick },
      opts.icon ?? null,
      h("span", { class: "n", text: label }),
      opts.count != null ? h("span", { class: "c", text: String(opts.count) }) : null,
    );
    row.classList.toggle("on", !!opts.on);
    if (opts.remove) {
      const x = h(
        "span",
        { class: "x", title: opts.removeTitle ?? "Remove" },
        svg(ICONS.xmark, 8),
      );
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.remove!();
      });
      row.append(x);
    }
    return row;
  }

  /** An inline "New folder…" field; Enter creates it. */
  function folderInput(onCreate: (name: string) => void): HTMLElement {
    const input = h("input", {
      class: "notes-menu-input",
      type: "text",
      placeholder: "New folder…",
      maxlength: "40",
      spellcheck: "false",
    }) as HTMLInputElement;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const name = Notes.addFolder(input.value);
        if (name) onCreate(name);
      }
    });
    return h("div", { class: "notes-menu-row" }, svg(ICONS.folder, 10), input);
  }

  function renderFilterMenu() {
    clear(filterMenu);
    const notes = Notes.notes;
    filterMenu.append(
      menuItem("All notes", {
        on: filter.kind === "all",
        count: notes.length,
        icon: svg(ICONS.note, 11, { stroke: 2 }),
        onClick: () => setFilter({ kind: "all" }),
      }),
      h("div", { class: "notes-menu-label", text: "Folders" }),
    );
    for (const name of Notes.folders) {
      filterMenu.append(
        menuItem(name, {
          on: filter.kind === "folder" && filter.name === name,
          count: notes.filter((n) => n.folder === name).length,
          icon: svg(ICONS.folder, 10),
          onClick: () => setFilter({ kind: "folder", name }),
          removeTitle: "Delete the folder (its notes are kept)",
          remove: () => {
            Notes.removeFolder(name);
            if (filter.kind === "folder" && filter.name === name) setFilter({ kind: "all" });
            else renderAll();
            renderFilterMenu();
          },
        }),
      );
    }
    filterMenu.append(folderInput((name) => setFilter({ kind: "folder", name })));
    filterMenu.append(h("div", { class: "notes-menu-label", text: "Tags" }));
    const tags = Notes.tags;
    if (tags.length === 0) {
      filterMenu.append(h("div", { class: "notes-menu-hint", text: "Tag a note to group it here." }));
    }
    for (const tag of tags) {
      filterMenu.append(
        menuItem(`#${tag}`, {
          on: filter.kind === "tag" && filter.name === tag,
          count: notes.filter((n) => n.tags.includes(tag)).length,
          onClick: () => setFilter({ kind: "tag", name: tag }),
        }),
      );
    }
  }

  function renderFolderMenu() {
    const note = current();
    clear(folderMenu);
    if (!note) return;
    const move = (folder: string | null) => {
      Notes.update(note.id, { folder });
      closeMenus();
      renderMeta();
      renderList();
    };
    folderMenu.append(menuItem("No folder", { on: note.folder == null, onClick: () => move(null) }));
    for (const name of Notes.folders) {
      folderMenu.append(
        menuItem(name, { on: note.folder === name, icon: svg(ICONS.folder, 10), onClick: () => move(name) }),
      );
    }
    folderMenu.append(folderInput((name) => move(name)));
  }

  function toggleMenu(menu: HTMLElement, render: () => void) {
    const open = !menu.classList.contains("open");
    closeMenus();
    if (!open) return;
    actions.blip();
    render();
    menu.classList.add("open");
  }

  filterBtn.addEventListener("click", () => toggleMenu(filterMenu, renderFilterMenu));
  folderChip.addEventListener("click", () => toggleMenu(folderMenu, renderFolderMenu));
  // A click anywhere else in the view closes an open menu.
  el.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (filterMenu.contains(t) || folderMenu.contains(t) || filterBtn.contains(t) || folderChip.contains(t)) return;
    closeMenus();
  });
  // Esc closes a menu before it folds the island.
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (filterMenu.classList.contains("open") || folderMenu.classList.contains("open")) {
      e.stopPropagation();
      closeMenus();
    }
  });

  // ── Tags ──────────────────────────────────────────────────────────────────

  function tagAdder(note: Note): HTMLElement {
    const add = h("button", { class: "notes-chip add", title: "Add a tag" }, svg(ICONS.tag, 10, { stroke: 2 }), h("span", { text: "Tag" }));
    add.addEventListener("click", () => {
      const input = h("input", {
        class: "notes-tag-input",
        type: "text",
        placeholder: "tag",
        maxlength: "32",
        spellcheck: "false",
      }) as HTMLInputElement;
      let done = false;
      const commit = (keepOpen: boolean) => {
        if (done) return;
        const t = cleanTag(input.value);
        if (t) {
          touched = true;
          Notes.addTag(note.id, t);
        }
        if (keepOpen && t) {
          input.value = "";
          renderTags(note, input);
          return;
        }
        done = true;
        renderTags(note);
        renderList();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === " ") {
          e.preventDefault();
          commit(e.key !== "Enter");
        } else if (e.key === "Escape") {
          e.stopPropagation();
          done = true;
          renderTags(note);
        } else if (e.key === "Backspace" && input.value === "" && note.tags.length) {
          Notes.removeTag(note.id, note.tags[note.tags.length - 1]);
          renderTags(note, input);
        }
      });
      input.addEventListener("blur", () => commit(false));
      add.replaceWith(input);
      input.focus();
    });
    return add;
  }

  /** Redraws the chips; `keep` is a tag field being typed in, put back at the end. */
  function renderTags(note: Note, keep?: HTMLInputElement) {
    clear(tagsEl);
    for (const tag of note.tags) {
      const x = h("span", { class: "x", title: "Remove tag" }, svg(ICONS.xmark, 7));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        touched = true;
        Notes.removeTag(note.id, tag);
        renderTags(note);
        renderList();
      });
      const chip = h(
        "button",
        { class: "notes-chip tag", title: `Show #${tag}`, onclick: () => setFilter({ kind: "tag", name: tag }) },
        h("span", { text: `#${tag}` }),
        x,
      );
      tagsEl.append(chip);
    }
    if (keep) {
      tagsEl.append(keep);
      keep.focus();
    } else {
      tagsEl.append(tagAdder(note));
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderFilterBtn() {
    clear(filterBtn);
    if (filter.kind === "folder") filterBtn.append(svg(ICONS.folder, 10));
    else if (filter.kind === "all") filterBtn.append(svg(ICONS.note, 11, { stroke: 2 }));
    const label = filter.kind === "all" ? "All notes" : filter.kind === "folder" ? filter.name : `#${filter.name}`;
    filterBtn.append(h("span", { class: "n", text: label }), svg(ICONS.chevronDown, 9, { stroke: 2.6 }));
  }

  function renderList() {
    const scroll = list.scrollTop;
    clear(list);
    if (Notes.status === "loading") {
      list.append(h("div", { class: "notes-hint", text: "Loading…" }));
      return;
    }
    if (Notes.status === "error") {
      list.append(h("div", { class: "notes-hint err", text: Notes.error ?? "Couldn't read your notes." }));
      return;
    }
    const visible = visibleNotes();
    if (visible.length === 0) {
      const text = search.value.trim() ? "Nothing matches." : Notes.notes.length ? "Nothing here yet." : "No notes yet.";
      list.append(h("div", { class: "notes-hint", text }));
    }
    for (const note of visible) {
      const snippet = textOf(note);
      const row = h(
        "button",
        { class: "notes-row", onclick: () => select(note.id) },
        h(
          "div",
          { class: "l1" },
          h("span", { class: "t", text: displayTitle(note) }),
          h("span", { class: "a", text: ago(note.updated) }),
        ),
        h("div", { class: "l2", text: (note.title.trim() ? snippet : snippet.slice(60).trim()) || "No additional text" }),
      );
      row.classList.toggle("on", note.id === selectedId);
      list.append(row);
    }
    list.scrollTop = scroll;
  }

  function renderMeta() {
    const note = current();
    clear(folderChip);
    if (!note) return;
    folderChip.append(
      svg(ICONS.folder, 10),
      h("span", { text: note.folder ?? "No folder" }),
      svg(ICONS.chevronDown, 8, { stroke: 2.6 }),
    );
    folderChip.classList.toggle("none", note.folder == null);
    renderTags(note);
  }

  function renderStatus() {
    status.textContent = Notes.error && Notes.status === "ready" ? "Not saved" : "";
    status.title = Notes.error ?? "";
  }

  function renderEmpty() {
    if (current()) return;
    clear(emptyEl);
    if (Notes.status !== "ready") return;
    const where =
      filter.kind === "folder" ? `in ${filter.name}` : filter.kind === "tag" ? `tagged #${filter.name}` : "";
    emptyEl.append(
      h("div", { class: "title", text: Notes.notes.length ? `No note ${where}`.trim() + "." : "Your notes live here." }),
      h("div", { class: "sub", text: "Lists, bold, checklists — saved on this PC only." }),
      h(
        "button",
        { class: "btn primary notes-new", onclick: () => newNote() },
        svg(ICONS.compose, 11),
        h("span", { text: "New note" }),
      ),
    );
  }

  function syncTools() {
    for (const { cmd, b } of toolButtons) b.classList.toggle("on", isActive(editor, cmd));
  }

  function renderAll() {
    const note = current();
    if (note && loadedId !== note.id) {
      title.value = note.title;
      editor.innerHTML = sanitizeHtml(note.html);
      editor.scrollTop = 0;
      loadedId = note.id;
      renderMeta();
      syncTools();
    } else if (!note) {
      loadedId = null;
    }
    noteEl.style.display = note ? "" : "none";
    emptyEl.style.display = note ? "none" : "";
    renderFilterBtn();
    renderList();
    renderStatus();
    renderEmpty();
  }

  Notes.subscribe(() => {
    // The first load picks a note to show.
    if (selectedId == null && Notes.status === "ready" && Notes.notes.length) {
      selectedId = visibleNotes()[0]?.id ?? null;
    }
    // A folder deleted under the filter, or a tag removed from its last note.
    if (filter.kind === "folder" && !Notes.folders.includes(filter.name)) filter = { kind: "all" };
    if (filter.kind === "tag" && !Notes.tags.includes(filter.name)) filter = { kind: "all" };
    if (loadedId !== selectedId) {
      renderAll();
    } else {
      renderFilterBtn();
      renderList();
      renderStatus();
      renderEmpty();
    }
  });

  renderAll();

  /** Something in the view has the keyboard. */
  function editing(): boolean {
    const a = document.activeElement;
    return a != null && a !== document.body && el.contains(a);
  }

  return {
    el,
    keyboard: true,
    show() {
      touched = false;
      void Notes.load();
      renderAll();
    },
    hide() {
      commitEditor();
      closeMenus();
      resetDelete();
      if (editing()) (document.activeElement as HTMLElement).blur();
      void Notes.flush();
    },
    engaged() {
      return touched && editing();
    },
    sync() {},
  };
}

function placeCaretAtEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
