// The notes editor: a contenteditable driven by the browser's own editing
// commands, plus what a note-taking field needs on top — checklists, Markdown
// shortcuts at the start of a line, plain-text paste, and a sanitiser so only a
// handful of formatting tags ever reach the screen or notes.json.

/** Tags a note may contain. Anything else is unwrapped (its text is kept). */
const ALLOWED = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "UL", "OL", "LI", "BR", "DIV", "P", "H3",
]);

/** Width of a checklist item's left padding (style.css, `.note-editor ul.check > li`). */
const CHECK_GUTTER = 20;

/** Removed with everything inside them. */
const DROPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "HEAD", "TITLE", "META", "LINK"]);

function cleanNode(node: Node, out: Node, doc: Document) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (DROPPED.has(el.tagName)) continue;
    if (!ALLOWED.has(el.tagName)) {
      cleanNode(el, out, doc);
      continue;
    }
    const copy = doc.createElement(el.tagName.toLowerCase());
    if (el.tagName === "UL" && el.classList.contains("check")) copy.className = "check";
    if (el.tagName === "LI" && el.hasAttribute("data-checked")) copy.setAttribute("data-checked", "");
    cleanNode(el, copy, doc);
    out.appendChild(copy);
  }
}

/** Keeps the allowed tags and the two checklist attributes, nothing else. */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  // An inert document: nothing in it loads or runs while it is parsed.
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out = document.implementation.createHTMLDocument("");
  const holder = out.createElement("div");
  cleanNode(parsed.body, holder, out);
  return holder.innerHTML;
}

/** The text of a note, one space between blocks, for search and previews. */
export function plainText(html: string): string {
  if (!html) return "";
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  parsed.querySelectorAll("li, div, p, h3, br").forEach((el) => {
    el.before(" ");
    el.after(" ");
  });
  return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── Editing ───────────────────────────────────────────────────────────────────

export type FormatCommand =
  | "bold" | "italic" | "underline" | "strikeThrough"
  | "heading" | "bullets" | "numbers" | "checklist";

function exec(command: string, value?: string) {
  // Deprecated but still the only way to get the browser's undo stack and
  // its list handling for free; WebView2 supports all of these.
  document.execCommand(command, false, value);
}

/** The closest element at the caret, inside `root`. */
function caretElement(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.anchorNode;
  if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
  return node && root.contains(node) ? (node as HTMLElement) : null;
}

function closestIn(root: HTMLElement, tag: string): HTMLElement | null {
  const el = caretElement(root)?.closest(tag) as HTMLElement | null;
  return el && root.contains(el) ? el : null;
}

export function isActive(root: HTMLElement, command: FormatCommand): boolean {
  if (!caretElement(root)) return false;
  switch (command) {
    case "heading":
      return closestIn(root, "h3") != null;
    case "bullets": {
      const ul = closestIn(root, "ul");
      return ul != null && !ul.classList.contains("check");
    }
    case "numbers":
      return closestIn(root, "ol") != null;
    case "checklist":
      return closestIn(root, "ul")?.classList.contains("check") ?? false;
    default:
      return document.queryCommandState(command);
  }
}

export function applyFormat(root: HTMLElement, command: FormatCommand) {
  root.focus();
  switch (command) {
    case "heading":
      exec("formatBlock", isActive(root, "heading") ? "div" : "h3");
      break;
    case "bullets": {
      const ul = closestIn(root, "ul");
      if (ul?.classList.contains("check")) {
        ul.classList.remove("check");
      } else if (!ul) {
        exec("insertUnorderedList");
        // Joined onto a checklist just above: bullets start their own list.
        const li = closestIn(root, "li");
        if (li?.parentElement?.classList.contains("check")) splitListAt(li).classList.remove("check");
      } else {
        exec("insertUnorderedList");
      }
      break;
    }
    case "numbers":
      exec("insertOrderedList");
      break;
    case "checklist": {
      const ul = closestIn(root, "ul");
      if (ul?.classList.contains("check")) {
        exec("insertUnorderedList");
      } else if (ul) {
        ul.classList.add("check");
      } else {
        exec("insertUnorderedList");
        const li = closestIn(root, "li");
        // Joined onto a bulleted list just above: the checklist starts its own.
        if (li?.parentElement && !li.parentElement.classList.contains("check")) {
          splitListAt(li).classList.add("check");
        }
      }
      break;
    }
    default:
      exec(command);
  }
  root.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The browser merges a new list into one right next to it. Moves `li` and the
 * items after it into a list of their own and returns the list `li` ends up in.
 */
function splitListAt(li: HTMLElement): HTMLElement {
  const list = li.parentElement!;
  if (!li.previousElementSibling) return list;
  // Ranges follow a moved node out to its old parent, so keep the caret as a
  // plain node and offset and put it back afterwards.
  const sel = window.getSelection();
  const caret = sel?.anchorNode ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
  const fresh = document.createElement(list.tagName.toLowerCase());
  list.after(fresh);
  for (let item: Element | null = li; item; ) {
    const next: Element | null = item.nextElementSibling;
    fresh.append(item);
    item = next;
  }
  if (caret && sel) sel.collapse(caret.node, caret.offset);
  return fresh;
}

/**
 * Markdown typed at the start of a line, turned into the format by the space
 * that follows it (a contenteditable types a trailing space as U+00A0).
 */
const SHORTCUTS: [RegExp, FormatCommand][] = [
  [/^[-*•][  ]$/, "bullets"],
  [/^1[.)][  ]$/, "numbers"],
  [/^\[[  ]?\][  ]$/, "checklist"],
  [/^#{1,3}[  ]$/, "heading"],
];

/** The line the caret is on: its list item or block, `root` for bare text. */
function currentBlock(root: HTMLElement): HTMLElement | null {
  const el = caretElement(root)?.closest("li, div, p, h3") as HTMLElement | null;
  return el && el !== root && root.contains(el) ? el : root;
}

function tryShortcut(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const block = currentBlock(root);
  if (!block || block.tagName === "LI") return false;

  const before = document.createRange();
  if (block === root) {
    // Text typed straight into the empty editor, before any block exists.
    const first = root.firstChild;
    if (!first) return false;
    before.setStartBefore(first);
  } else {
    before.setStart(block, 0);
  }
  before.setEnd(sel.anchorNode!, sel.anchorOffset);
  const typed = before.toString();
  const match = SHORTCUTS.find(([re]) => re.test(typed));
  if (!match) return false;
  // Headings and lists do not nest into each other this way.
  if (match[1] !== "heading" && closestIn(root, "h3")) return false;

  sel.removeAllRanges();
  sel.addRange(before);
  exec("delete");
  applyFormat(root, match[1]);
  return true;
}

/**
 * Wires the editing behaviour onto a contenteditable. `onChange` runs after
 * every edit, including checkbox clicks.
 */
export function enhanceEditor(root: HTMLElement, onChange: () => void) {
  root.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Tab") {
      // Nests list items; never leaves the field.
      e.preventDefault();
      if (closestIn(root, "li")) {
        exec(e.shiftKey ? "outdent" : "indent");
        onChange();
      }
      return;
    }
    if (mod && e.shiftKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      applyFormat(root, "strikeThrough");
    } else if (mod && e.shiftKey && e.key === "8") {
      e.preventDefault();
      applyFormat(root, "bullets");
    } else if (mod && e.shiftKey && e.key === "7") {
      e.preventDefault();
      applyFormat(root, "numbers");
    } else if (mod && e.shiftKey && e.key === "9") {
      e.preventDefault();
      applyFormat(root, "checklist");
    }
  });

  // Plain text only: formatting pasted from a web page would bring its styles,
  // links and images along.
  root.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) exec("insertText", text);
  });
  root.addEventListener("drop", (e) => {
    if (e.dataTransfer?.types.includes("text/html")) e.preventDefault();
  });

  /** A shortcut is being applied: its own edits are not reported one by one. */
  let applying = false;

  root.addEventListener("input", (e) => {
    if (applying) return;
    const input = e as InputEvent;
    if (input.inputType === "insertText" && input.data?.endsWith(" ")) {
      // Checked once the space is in, so it works however it was typed. Not
      // from inside this handler: the browser refuses an editing command
      // started while another one is still being dispatched.
      queueMicrotask(() => {
        applying = true;
        const done = tryShortcut(root);
        applying = false;
        if (done) onChange();
      });
    }
    // Enter after a ticked item starts an unticked one.
    if (input.inputType === "insertParagraph") {
      const li = closestIn(root, "li");
      if (li?.hasAttribute("data-checked")) li.removeAttribute("data-checked");
    }
    onChange();
  });

  // Ticking a box: a click in the item's left padding, where the box is drawn.
  root.addEventListener("mousedown", (e) => {
    const li = (e.target as HTMLElement).closest("ul.check > li") as HTMLElement | null;
    if (!li || !root.contains(li)) return;
    const box = li.getBoundingClientRect();
    // The island may be zoomed: compare in the item's own, unscaled pixels.
    const scale = box.width / li.offsetWidth || 1;
    if ((e.clientX - box.left) / scale > CHECK_GUTTER) return;
    e.preventDefault();
    li.toggleAttribute("data-checked");
    onChange();
  });
}
