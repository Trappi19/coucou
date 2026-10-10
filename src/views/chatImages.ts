// Pictures in Mochi's answers. Mochi writes them as Markdown images
// (`![a stork](https://upload.wikimedia.org/…/stork.jpg)`, see the system
// prompts); the text keeps its words and the pictures go in a row of thumbnails
// underneath. Rust downloads each one (images.rs) and the page shows it from a
// blob: URL — the island itself never loads anything from the internet.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";

export interface ChatImage {
  alt: string;
  url: string;
}

/** At most this many pictures per answer. */
const MAX_IMAGES = 6;
const IMAGE = /!\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)/g;

/** The words of an answer, and its pictures (each link once). */
export function splitImages(text: string): { text: string; images: ChatImage[] } {
  const images: ChatImage[] = [];
  const stripped = text.replace(IMAGE, (_m, alt: string, url: string) => {
    if (images.length < MAX_IMAGES && !images.some((i) => i.url === url)) images.push({ alt: alt.trim(), url });
    return "";
  });
  // The lines the pictures stood on leave no gap behind.
  return { text: stripped.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"), images };
}

/**
 * The same, while the answer is still coming in: a picture link not yet
 * complete is held back, so its Markdown never flashes on screen. The result
 * only ever grows, which the reveal of the live bubble relies on.
 */
export function splitStreaming(raw: string): { text: string; images: ChatImage[] } {
  const { text, images } = splitImages(raw);
  let cut = text.length;
  const open = text.lastIndexOf("![");
  if (open >= 0 && !/\)/.test(text.slice(open))) cut = open;
  else if (text.endsWith("!")) cut = text.length - 1;
  return { text: text.slice(0, cut), images };
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** One download per link for the whole session; the same picture shows at once. */
const cache = new Map<string, Promise<string>>();

function load(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = Bridge.chatImage(url).then((bytes) => URL.createObjectURL(new Blob([bytes])));
    // A failure may be passing (a network blip): try again next time.
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

// ── The row of thumbnails ─────────────────────────────────────────────────────

/**
 * Thumbnails for `images`: a shimmer while each loads, then the picture fades
 * in; a click opens it large in `host`. `onLoad` runs as each one arrives
 * (the log keeps following the bottom).
 */
export function gallery(images: ChatImage[], host: () => HTMLElement | null, onLoad: () => void): HTMLElement {
  const row = h("div", { class: "chat-gallery" });
  for (const image of images) row.append(tile(image, host, onLoad));
  return row;
}

/** Adds thumbnails for pictures not in `row` yet (the live answer). */
export function extendGallery(row: HTMLElement, images: ChatImage[], host: () => HTMLElement | null, onLoad: () => void) {
  const have = new Set([...row.children].map((c) => (c as HTMLElement).dataset.url));
  for (const image of images) if (!have.has(image.url)) row.append(tile(image, host, onLoad));
}

function tile(image: ChatImage, host: () => HTMLElement | null, onLoad: () => void): HTMLElement {
  const el = h("button", { class: "chat-img", title: image.alt || "Picture" });
  el.dataset.url = image.url;
  // Seen before in this session: shown at once, without the fade.
  if (cache.has(image.url)) el.classList.add("instant");
  const img = h("img", { alt: image.alt, draggable: "false" }) as HTMLImageElement;
  el.append(img);
  load(image.url)
    .then((src) => {
      img.onload = () => {
        el.classList.add("loaded");
        onLoad();
      };
      img.onerror = () => fail(el, image);
      img.src = src;
    })
    .catch((err) => fail(el, image, String(err).replace(/^Error:\s*/, "")));
  el.addEventListener("click", () => {
    if (!el.classList.contains("loaded")) {
      // Not a picture we could show: the link itself, in the browser.
      if (el.classList.contains("failed")) void Bridge.openUrl(image.url);
      return;
    }
    const where = host();
    if (where) openViewer(where, image, img.src);
  });
  return el;
}

function fail(el: HTMLElement, image: ChatImage, why = "") {
  el.classList.add("failed");
  el.replaceChildren(svg(ICONS.arrowUpRight, 9), h("span", { text: "Picture unavailable" }));
  el.title = `${why || "Couldn't load this picture."} Click to open the link.\n${image.url}`;
}

// ── Seen large ────────────────────────────────────────────────────────────────

/** The picture over the whole card, with its description; Esc or a click closes it. */
function openViewer(host: HTMLElement, image: ChatImage, src: string) {
  host.querySelector(".chat-viewer")?.remove();
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("viewing-picture");
    viewer.classList.add("closing");
    window.setTimeout(() => viewer.remove(), 180);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Esc closes the picture, not the island.
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  const open = h(
    "button",
    { class: "btn secondary chat-viewer-open", onclick: (e: Event) => { e.stopPropagation(); void Bridge.openUrl(image.url); } },
    svg(ICONS.arrowUpRight, 9),
    h("span", { text: "Open" }),
  );
  const shut = h(
    "button",
    { class: "chat-viewer-close", title: "Close (Esc)", onclick: (e: Event) => { e.stopPropagation(); close(); } },
    svg(ICONS.xmark, 9),
  );
  const viewer = h(
    "div",
    { class: "chat-viewer", onclick: () => close() },
    h("img", { src, alt: image.alt, draggable: "false" }),
    h("div", { class: "chat-viewer-bar" }, h("span", { class: "chat-viewer-alt", text: image.alt }), open, shut),
  );
  host.append(viewer);
  // Mochi steps aside: it is drawn above everything, the picture included.
  document.body.classList.add("viewing-picture");
  document.addEventListener("keydown", onKey, true);
}
