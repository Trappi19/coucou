// The GitHub card once the pulse is in — DOM ports of GitHubPulseCardView,
// GitHubDetailView, GitHubPRRowView, GitHubRepoCIRowView and
// GitHubActivityDetailContent (IslandViewContent.swift). Sizes, colours and
// wording follow the Swift views; the logic lives in core/github.ts.
//
// Without a pulse (no token scope for it yet, or the first poll still to come)
// the card stays the stars + repositories overview in integrations.ts.
//
// From upstream Coucou (windows/src/views/github.ts, 0.2.0), plus the streak.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { countUp, staggered, swapText } from "./motion";
import {
  CI_COLORS, GH_STRINGS, GRID_WEEKS, activityHeader, actionsUrl, ciWord, contributionColor,
  formatCount, lastDays, lastWeeks, mainCISummary, myPRsValue, profileUrl, safeGitHubUrl,
  sectionTitle, shortRepo, streakDays, weekColumn, worstCI,
  type ContributionDay, type GitHubActivity, type GitHubPR, type GitHubPulse, type GitHubRepoCI,
  type GitHubSection, type GitHubStats,
} from "../core/github";

const GITHUB_RED = "#F4505E";

/** Which list the detail view shows; kept across re-renders of the card. */
let openSection: GitHubSection = "myPRs";

function open(url: string) {
  const safe = safeGitHubUrl(url);
  if (safe) void Bridge.openUrl(safe);
}

/**
 * The last week of contributions: seven small squares that light up one after
 * the other, then how many contributions that makes, counting up.
 */
function miniRow(activity: GitHubActivity, animate: boolean): HTMLElement {
  const row = h("span", { class: "gh-mini" });
  const week = lastDays(activity, 7);
  week.forEach((day, i) => {
    const square = h("i", { style: `background:${contributionColor(day.level)}` });
    row.append(animate ? staggered(square, i, 55, 220) : square);
  });
  const total = week.reduce((sum, d) => sum + d.count, 0);
  const count = h("span", { class: "gh-week-count", title: `${GH_STRINGS.contributions(total)} this week` });
  if (animate) countUp(count, total, String, { delay: 260, duration: 650 });
  else count.textContent = String(total);
  row.append(count);
  return row;
}

function statButton(icon: SVGSVGElement, color: string, label: string, value: string, onClick: () => void): HTMLElement {
  return h(
    "button",
    { class: "int-stat gh-stat", onclick: onClick },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, icon),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function githubPulseCard(
  pulse: GitHubPulse,
  stats: GitHubStats | null,
  activity: GitHubActivity | null,
  openDetail: () => void,
  animate = false,
): HTMLElement {
  const show = (section: GitHubSection) => {
    openSection = section;
    void Bridge.githubRefresh(section === "activity" ? "activity" : "pulse");
    openDetail();
  };

  const head = h("div", { class: "int-head" }, dot(GITHUB_RED, 7), h("b", { text: GH_STRINGS.title }));
  if (stats || activity) {
    const spark = h("button", { class: "gh-spark", onclick: () => show("activity") });
    const streak = streakDays(activity);
    if (streak > 0) {
      const flame = h("span", { class: "gh-streak", title: GH_STRINGS.streak(streak) });
      if (animate) countUp(flame, streak, (n) => `🔥 ${n}`, { delay: 120, duration: 600 });
      else flame.textContent = `🔥 ${streak}`;
      spark.append(flame);
    }
    // The week's contributions need the room; the stars ride in the tooltip.
    if (stats) {
      spark.title = `★ ${formatCount(stats.totalStars)} · ${GH_STRINGS.repos(stats.totalRepos)}`;
      if (!activity) spark.append(h("span", { text: `★ ${formatCount(stats.totalStars)}` }));
    }
    if (activity) spark.append(miniRow(activity, animate));
    head.append(spark);
  } else {
    head.append(h("span", { text: GH_STRINGS.overview }));
  }

  const prColor = CI_COLORS[worstCI(pulse.myPRs.map((p) => p.ci))];
  const reviews = pulse.toReview.length;
  const main = mainCISummary(pulse.mainCI);

  return h(
    "div",
    { class: "int-card" },
    head,
    h(
      "div",
      { class: "int-stats gh-rows" },
      statButton(svg(ICONS.pull, 10, { stroke: 2.2 }), prColor, GH_STRINGS.myPRs, myPRsValue(pulse.myPRs),
        () => show("myPRs")),
      statButton(svg(ICONS.eye, 10, { stroke: 2.2 }), reviews > 0 ? "#8AB4F8" : "#6B7079", GH_STRINGS.toReview,
        String(reviews), () => show("toReview")),
      statButton(svg(main.failing ? ICONS.octagonX : ICONS.seal, 10, { evenOdd: true }), main.color,
        GH_STRINGS.mainCI, main.value, () => show("mainCI")),
    ),
  );
}

// ── Detail: lists ─────────────────────────────────────────────────────────────

function backButton(title: string, onBack: () => void): HTMLElement {
  return h(
    "button",
    { class: "gh-back", onclick: onBack },
    svg(ICONS.chevronLeft, 9, { stroke: 2.6 }),
    h("span", { text: title }),
  );
}

function ciDot(ci: GitHubPR["ci"]): HTMLElement {
  const el = dot(CI_COLORS[ci], 5);
  if (ci === "unknown") el.style.opacity = "0";
  return el;
}

function prRow(pr: GitHubPR, showCI: boolean): HTMLElement {
  return h(
    "button",
    { class: "gh-row", onclick: () => open(pr.url) },
    showCI ? ciDot(pr.ci) : h("i", { class: "gh-gap" }),
    h("span", { class: "gh-ref", text: `${shortRepo(pr.repo)}#${pr.number}` }),
    h("span", { class: "gh-title", text: pr.title }),
    pr.isDraft ? h("span", { class: "gh-draft", text: GH_STRINGS.draft }) : null,
  );
}

function repoRow(repo: GitHubRepoCI): HTMLElement {
  const word = ciWord(repo.ci);
  return h(
    "button",
    { class: "gh-row", onclick: () => open(actionsUrl(repo.url)) },
    ciDot(repo.ci),
    h("span", { class: "gh-ref", text: shortRepo(repo.repo) }),
    h("span", { class: "gh-title", text: repo.branch }),
    word ? h("span", { class: "gh-word", style: `color:${CI_COLORS[repo.ci]}`, text: word }) : null,
  );
}

function listDetail(
  section: Exclude<GitHubSection, "activity">,
  pulse: GitHubPulse,
  onBack: () => void,
  animate: boolean,
): HTMLElement {
  const rows: HTMLElement[] =
    section === "mainCI"
      ? pulse.mainCI.map(repoRow)
      : (section === "myPRs" ? pulse.myPRs : pulse.toReview).map((pr) => prRow(pr, section === "myPRs"));
  // One after the other, as the words of an answer do.
  if (animate) rows.forEach((row, i) => staggered(row, i, 45, 90));

  const body =
    rows.length === 0
      ? h("div", { class: "gh-empty", text: GH_STRINGS.nothingHere })
      : h("div", { class: rows.length > 3 ? "gh-list fade" : "gh-list" }, ...rows);

  return h(
    "div",
    { class: "int-card" },
    h("div", { class: "gh-detail-head" }, backButton(sectionTitle(section), onBack)),
    body,
  );
}

// ── Detail: contribution grid ─────────────────────────────────────────────────

function activityDetail(
  activity: GitHubActivity | null,
  stats: GitHubStats | null,
  login: string,
  onBack: () => void,
  animate: boolean,
): HTMLElement {
  const right = h("button", {
    class: "gh-head-right",
    text: activityHeader(activity, stats, null),
    onclick: () => open(profileUrl(login)),
  });
  // The year's contributions count up as the grid fills in.
  let stopCount = () => {};
  if (animate && activity) {
    stopCount = countUp(right, activity.total, (n) => activityHeader({ ...activity, total: n }, stats, null), {
      delay: 120,
      duration: 900,
    });
  }

  let picked: ContributionDay | null = null;
  const show = (day: ContributionDay | null) => {
    stopCount();
    picked = day;
    swapText(right, activityHeader(activity, stats, day));
  };

  const head = h("div", { class: "gh-detail-head" }, backButton(GH_STRINGS.activity, onBack));
  const streak = streakDays(activity);
  if (streak > 0) head.append(h("span", { class: "gh-streak", title: GH_STRINGS.streak(streak), text: `🔥 ${streak}` }));
  if (activity) head.append(right);

  if (!activity) {
    return h("div", { class: "int-card" }, head, h("div", { class: "gh-empty", text: GH_STRINGS.loading }));
  }

  const grid = h("div", { class: "gh-grid" });
  lastWeeks(activity, GRID_WEEKS).forEach((week, col) => {
    const column = h("div", { class: "gh-week" });
    weekColumn(week).forEach((day, row) => {
      if (!day) {
        column.append(h("i", { class: "gh-cell empty" }));
        return;
      }
      const cell = h("i", { class: "gh-cell", style: `background:${contributionColor(day.level)}` });
      // A diagonal wave, oldest week first, as if the year were being written.
      if (animate) cell.style.animationDelay = `${60 + col * 16 + row * 9}ms`;
      cell.addEventListener("mouseenter", () => show(day));
      cell.addEventListener("mouseleave", () => show(null));
      cell.addEventListener("click", () => show(picked?.date === day.date ? null : day));
      column.append(cell);
    });
    grid.append(column);
  });
  return h("div", { class: "int-card" }, head, grid);
}

export function githubDetail(
  pulse: GitHubPulse,
  stats: GitHubStats | null,
  activity: GitHubActivity | null,
  onBack: () => void,
  animate = false,
): HTMLElement {
  return openSection === "activity"
    ? activityDetail(activity, stats, pulse.login, onBack, animate)
    : listDetail(openSection, pulse, onBack, animate);
}
