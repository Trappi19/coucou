// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.
//
// Unlike macOS, compact never times out to hidden: there is no notch to find the
// island in again, so Mochi stays at the top of the screen for as long as the
// app runs. Hidden is only reached through Pause.

export type FsmState = "hidden" | "petit" | "home" | "coucou";

/** Shortest stay for an island that opened by itself (an alert) and was never hovered. */
const UNATTENDED_MIN_DELAY = 6;

/**
 * How long the cursor has to rest on compact before it opens by itself. The top
 * of the screen is on the way to browser tabs and title bars: passing over
 * Mochi must not open it.
 */
const HOVER_OPEN_DELAY = 0.35;

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay once the mouse has left, seconds. 0 = straight away. */
  homeToPetitDelay = 15;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /** True while the island is in use (a conversation, a file): it never folds by itself. */
  holdOpen: () => boolean = () => false;
  /** Compact opens when the cursor rests on it, no click needed. */
  openOnHover = false;

  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;
  private hoverOpen: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        if (this.openOnHover) this.scheduleHoverOpen();
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.clear("hoverOpen");
        break;
      case "home":
        this.scheduleHomeCollapse(this.homeToPetitDelay);
        break;
      case "coucou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  /** The island opened while the mouse was elsewhere (an alert): leave time to read it. */
  openedUnattended() {
    if (this.state !== "home") return;
    this.scheduleHomeCollapse(Math.max(this.homeToPetitDelay, UNATTENDED_MIN_DELAY));
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private scheduleHomeCollapse(delay: number) {
    this.clear("homeCollapse");
    if (this.pinned || this.holdOpen()) return;
    const fold = () => {
      this.homeCollapse = null;
      // Checked again: a conversation may have started since.
      if (this.state === "home" && !this.pinned && !this.holdOpen()) this.transition("petit");
    };
    if (delay <= 0) {
      fold();
      return;
    }
    this.homeCollapse = window.setTimeout(fold, delay * 1000);
  }

  private scheduleHoverOpen() {
    this.clear("hoverOpen");
    this.hoverOpen = window.setTimeout(() => {
      this.hoverOpen = null;
      if (this.state === "petit") this.transition("home");
    }, HOVER_OPEN_DELAY * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "coucou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "homeCollapse" | "greetCollapse" | "hoverOpen") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("homeCollapse");
    this.clear("greetCollapse");
    this.clear("hoverOpen");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
