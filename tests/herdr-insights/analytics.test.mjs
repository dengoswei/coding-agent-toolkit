import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Exercise the file as an ES module without relying on a package.json "type".
process.env.TZ = "America/New_York";
const source = await readFile(new URL("../../herdr-insights/mods/insights/analytics.js", import.meta.url), "utf8");
const analytics = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const {
  addDays,
  addMonthsClamped,
  addYearsClamped,
  activityDays,
  availableYears,
  buildHeatmap,
  buildModelSeries,
  compareChange,
  createDashboardCache,
  dayKey,
  dayLabel,
  deriveDashboard,
  eventStatistics,
  facetStatsAll,
  filterRows,
  filterRowsByRange,
  formatCompact,
  formatDuration,
  formatInt,
  heatmapTooltip,
  initials,
  intensityLevel,
  isDay,
  leaderboard,
  normalizeConfig,
  parseDay,
  peakDay,
  periodRange,
  startOfWeek,
  streakStats,
  sumTokens,
  tokenTotal,
  weekdayLabels,
} = analytics;

function row(overrides = {}) {
  return {
    day: "2024-01-01",
    session: "session-1",
    harness: "pi",
    provider: "openai",
    model: "gpt-test",
    project: "/repo/insights",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 },
    messages: 1,
    activeMs: 1000,
    longestTaskMs: 1000,
    ...overrides,
  };
}

test("continuations combine trigger sources by tool across periods and machine scopes", () => {
  const event = (id, tool, origin, outcome, day = "2026-11-06", machine = "local") =>
    ({ id, type: "nudge_continue", tool, origin, outcome, day, machine });
  const events = [
    event("1", "codex", "shepherd", "sent"),
    event("2", "codex", "stop-hook:codex_stop", "issued", "2026-11-05", "remote"),
    event("3", "codex", "stop-hook:codex_stop", "issued", "2026-10-05"),
    event("4", "codex", "shepherd", "sent", "2025-12-01"),
    event("5", "codex", "shepherd", "attempted"),
    event("6", "codex", "shepherd", "held"),
    event("7", "claude", "shepherd", "sent"),
    event("8", "claude", "stop-hook:claude_stop", "issued"),
    event("9", "cursor", "shepherd", "sent"),
    event("10", "pi", "stop-hook:pi_settle", "issued"),
    event("11", "kimi", "shepherd", "sent"),
  ];
  const stats = eventStatistics([...events, events[0]], { today: "2026-11-06" });
  assert.equal(stats.nudges.length, 5);
  assert.deepEqual(stats.nudges[0], {
    name: "codex", week: 2, month: 2, year: 3, total: 4,
    sent: 2, issued: 2, attempted: 1, held: 1,
  });
  assert.equal(stats.nudges.find((entry) => entry.name === "claude").total, 2);
  const local = eventStatistics(events, { today: "2026-11-06", machine: "local" });
  assert.equal(local.nudges[0].total, 3);
  assert.equal(local.nudges[0].week, 1);
});

test("token accounting counts cache only when included and reasoning only once", () => {
  const tokens = { input: 100, output: 20, cacheRead: 80, cacheWrite: 5, reasoning: 5, total: 999 };
  assert.equal(tokenTotal(tokens, true), 205);
  assert.equal(tokenTotal(tokens, false), 120);
  assert.equal(tokenTotal({ total: 50 }, false), 50);

  const rows = [
    row({ session: "s1", tokens }),
    row({ session: "s2", tokens }),
  ];
  const included = sumTokens(rows, true);
  assert.equal(included.total, 410);
  assert.equal(included.input, 200);
  assert.equal(included.output, 40);
  assert.equal(included.cacheRead, 160);
  assert.equal(included.cacheWrite, 10);
  assert.equal(included.reasoning, 10);
  assert.equal(included.sessions, 2);

  const excluded = sumTokens(rows, false);
  assert.equal(excluded.total, 240);
  assert.equal(excluded.cacheRead, 160);
});

test("local calendar arithmetic handles leap days and DST", () => {
  assert.equal(isDay("2024-02-29"), true);
  assert.equal(isDay("2023-02-29"), false);
  assert.equal(isDay("2024-13-01"), false);
  assert.equal(dayKey(parseDay("2024-02-29")), "2024-02-29");

  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDays("2024-03-09", 1), "2024-03-10");
  assert.equal(addDays("2024-03-10", 1), "2024-03-11");
  assert.equal(addDays("2024-11-02", 1), "2024-11-03");
  assert.equal(addDays("2024-03-10", -1), "2024-03-09");

  assert.equal(addMonthsClamped("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonthsClamped("2023-01-31", 1), "2023-02-28");
  assert.equal(addYearsClamped("2024-02-29", 1), "2025-02-28");

  assert.equal(startOfWeek("2024-01-03", 0), "2023-12-31");
  assert.equal(startOfWeek("2024-01-03", 1), "2024-01-01");
  assert.deepEqual(weekdayLabels(1).slice(0, 2), ["Mon", ""]);
  assert.equal(dayLabel("2024-01-03", { year: false }), "Jan 3");
});

test("heatmap is 53 local weeks of 7 consecutive days", () => {
  const heatmap = buildHeatmap([], { endDay: "2024-03-10", weeks: 53, weekStartsOn: 0 });
  assert.equal(heatmap.weeks.length, 53);
  assert.equal(heatmap.cells.length, 371);
  assert.equal(heatmap.weeks[0].days[0].date, addDays(startOfWeek("2024-03-10", 0), -52 * 7));
  assert.equal(heatmap.weeks[52].days[0].date, startOfWeek("2024-03-10", 0));
  assert.ok(heatmap.cells.some((cell) => cell.date === "2024-03-10"));
  assert.equal(heatmap.cells.filter((cell) => cell.date === "2024-03-10").length, 1);
  assert.equal(heatmap.months.reduce((total, month) => total + month.span, 0), 53);
  for (let index = 1; index < heatmap.cells.length; index += 1) {
    assert.equal(heatmap.cells[index].date, addDays(heatmap.cells[index - 1].date, 1));
  }
});

test("heatmap daily, weekly and cumulative math is exact", () => {
  const rows = [
    row({ day: "2024-01-01", session: "a", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ day: "2024-01-02", session: "a", tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ day: "2024-01-08", session: "b", tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ];
  const options = { endDay: "2024-01-14", weeks: 3, weekStartsOn: 0 };
  const daily = buildHeatmap(rows, { ...options, mode: "daily" });
  const byDay = (heatmap, day) => heatmap.cells.find((cell) => cell.date === day);
  assert.equal(byDay(daily, "2024-01-01").value, 10);
  assert.equal(byDay(daily, "2024-01-02").value, 20);
  assert.equal(byDay(daily, "2024-01-08").value, 5);
  assert.equal(daily.maxValue, 20);
  assert.equal(byDay(daily, "2024-01-01").sessions, 1);
  assert.equal(byDay(daily, "2024-01-08").sessions, 1);

  const weekly = buildHeatmap(rows, { ...options, mode: "weekly" });
  assert.equal(byDay(weekly, "2024-01-01").value, 30);
  assert.equal(byDay(weekly, "2024-01-06").value, 30);
  assert.equal(byDay(weekly, "2024-01-08").value, 5);
  assert.equal(byDay(weekly, "2024-01-14").value, 0);
  assert.equal(weekly.maxValue, 30);
  assert.equal(byDay(weekly, "2024-01-08").weekSessions, 1);

  const cumulative = buildHeatmap(rows, { ...options, mode: "cumulative" });
  assert.equal(byDay(cumulative, "2024-01-01").value, 10);
  assert.equal(byDay(cumulative, "2024-01-02").value, 30);
  assert.equal(byDay(cumulative, "2024-01-07").value, 30);
  assert.equal(byDay(cumulative, "2024-01-08").value, 35);
  assert.equal(byDay(cumulative, "2024-01-14").value, 35);
  assert.equal(byDay(cumulative, "2024-01-08").cumulativeSessions, 2);
  assert.equal(cumulative.maxValue, 35);

  const future = byDay(daily, "2024-01-15");
  assert.equal(future.future, true);
  assert.equal(future.level, 0);
  assert.equal(heatmapTooltip(future, "daily"), "");
  assert.match(heatmapTooltip(byDay(daily, "2024-01-02"), "daily"), /Jan 2, 2024: 20 tokens/);
  assert.match(byDay(daily, "2024-01-02").tooltip, /Jan 2, 2024: 20 tokens/);
  assert.match(heatmapTooltip(byDay(weekly, "2024-01-08"), "weekly"), /Week of Jan 7: 5 tokens/);
  assert.match(heatmapTooltip(byDay(cumulative, "2024-01-08"), "cumulative"), /Through Mon, Jan 8, 2024: 35 tokens/);
});

test("heatmap respects includeCache", () => {
  const rows = [row({ day: "2024-01-01", tokens: { input: 0, output: 0, cacheRead: 100, cacheWrite: 0 } })];
  const included = buildHeatmap(rows, { endDay: "2024-01-13", weeks: 2, mode: "daily", includeCache: true });
  const excluded = buildHeatmap(rows, { endDay: "2024-01-13", weeks: 2, mode: "daily", includeCache: false });
  assert.equal(included.cells.find((cell) => cell.date === "2024-01-01").value, 100);
  assert.equal(excluded.cells.find((cell) => cell.date === "2024-01-01").value, 0);
});

test("filters match source, provider, model and project exactly", () => {
  const rows = [
    row({ harness: "pi", provider: "openai", model: "gpt-a", project: "/a" }),
    row({ harness: "claude", provider: "anthropic", model: "claude-a", project: "/b" }),
  ];
  assert.equal(filterRows(rows, { source: "pi" }).length, 1);
  assert.equal(filterRows(rows, { source: "all" }).length, 2);
  assert.equal(filterRows(rows, { harness: "claude", provider: "anthropic" }).length, 1);
  assert.equal(filterRows(rows, { model: "gpt-a", project: "/a" }).length, 1);
  assert.equal(filterRows(rows, { provider: "missing" }).length, 0);

  const facets = facetStatsAll(rows, { source: "pi" });
  assert.deepEqual(facets.source.map((stat) => stat.value).sort(), ["claude", "pi"]);
  assert.deepEqual(facets.provider.map((stat) => stat.value), ["openai"]);
  assert.match(facets.provider[0].meta, /\d/);
});

test("period ranges use calendar boundaries and equivalent previous periods", () => {
  const week = periodRange("week", { today: "2024-01-10", weekStartsOn: 1 });
  assert.deepEqual(week.start, "2024-01-08");
  assert.deepEqual(week.end, "2024-01-10");
  assert.deepEqual(week.previous, { start: "2024-01-01", end: "2024-01-03" });

  const month = periodRange("month", { today: "2024-03-31" });
  assert.equal(month.start, "2024-03-01");
  assert.equal(month.end, "2024-03-31");
  assert.deepEqual(month.previous, { start: "2024-02-01", end: "2024-02-29" });

  const pastYear = periodRange("year", { today: "2024-03-31", year: 2023 });
  assert.equal(pastYear.start, "2023-01-01");
  assert.equal(pastYear.end, "2023-12-31");
  assert.deepEqual(pastYear.previous, { start: "2022-01-01", end: "2022-12-31" });

  const currentYear = periodRange("year", { today: "2024-03-31", year: 2024 });
  assert.equal(currentYear.end, "2024-03-31");
  assert.deepEqual(currentYear.previous, { start: "2023-01-01", end: "2023-03-31" });

  const all = periodRange("all", { today: "2024-03-31" });
  assert.equal(all.start, null);
  assert.equal(all.previous, null);

  assert.equal(filterRowsByRange([row({ day: "2024-01-01" }), row({ day: "2024-02-01" })], month).length, 0);
  assert.equal(filterRowsByRange([row({ day: "2024-01-01" })], all).length, 1);
});

test("streaks are deduped by day and current streak has yesterday grace", () => {
  const today = "2024-01-10";
  const days = (...values) => values.map((day) => row({ day, session: `s-${day}` }));
  assert.deepEqual(streakStats(days("2024-01-08", "2024-01-09"), { today }), {
    current: 2,
    longest: 2,
    activeDays: 2,
    lastActive: "2024-01-09",
  });
  assert.equal(streakStats(days("2024-01-08"), { today }).current, 0);
  assert.equal(streakStats(days("2024-01-10"), { today }).current, 1);
  assert.equal(streakStats(days("2024-01-10", "2024-01-08"), { today }).current, 1);
  const split = streakStats(days("2024-01-01", "2024-01-02", "2024-01-03", "2024-01-08", "2024-01-09"), { today });
  assert.equal(split.longest, 3);
  assert.equal(split.current, 2);
  assert.equal(streakStats(days("2024-01-11"), { today }).current, 0);
  assert.equal(activityDays([row({ day: "2024-01-01", tokens: {}, messages: 1 })]).length, 1);
  const cacheOnly = [row({ day: "2024-01-09", session: "cache", messages: 0, longestTaskMs: 0, tokens: { input: 0, output: 0, cacheRead: 50, cacheWrite: 0 } })];
  assert.equal(streakStats(cacheOnly, { today, includeCache: true }).current, 1);
  assert.equal(streakStats(cacheOnly, { today, includeCache: false }).current, 0);
});

test("peak day dedupes sessions and respects includeCache", () => {
  const rows = [
    row({ day: "2024-01-01", session: "a", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ day: "2024-01-01", session: "a", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ day: "2024-01-02", session: "b", tokens: { input: 15, output: 0, cacheRead: 100, cacheWrite: 0 } }),
  ];
  const peak = peakDay(rows, true);
  assert.deepEqual(peak, { day: "2024-01-02", tokens: 115, sessions: 1 });
  const noCache = peakDay(rows, false);
  assert.deepEqual(noCache, { day: "2024-01-01", tokens: 20, sessions: 1 });
});

test("leaderboard ranks, dedupes sessions and handles New and zero comparisons", () => {
  const current = [
    row({ session: "s1", model: "model-a", provider: "p1", tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ session: "s1", model: "model-a", provider: "p1", tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ session: "s2", model: "model-b", provider: "p2", tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ session: "s3", model: "model-c", provider: "p2", tokens: { input: 0, output: 0, cacheRead: 10, cacheWrite: 0 } }),
  ];
  const previous = [
    row({ session: "old-a", model: "model-a", provider: "p1", tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ session: "old-b", model: "model-b", provider: "p2", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    row({ session: "old-c", model: "model-c", provider: "p2", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ];

  const models = leaderboard(current, previous, { groupBy: "model", includeCache: false, limit: 0 });
  assert.equal(models.totalTokens, 200);
  assert.equal(models.totalSessions, 3);
  assert.deepEqual(models.entries.map((entry) => [entry.rank, entry.name, entry.tokens]), [
    [1, "model-a", 150],
    [2, "model-b", 50],
    [3, "model-c", 0],
  ]);
  assert.equal(models.entries[0].sessions, 1);
  assert.equal(models.entries[0].change.label, "+50.0%");
  assert.equal(models.entries[1].change.kind, "new");
  assert.equal(models.entries[1].change.label, "New");
  assert.equal(models.entries[2].change.kind, "flat");
  assert.equal(models.entries[2].change.label, "0%");
  assert.equal(models.entries[0].share, 0.75);
  assert.equal(models.entries[0].sublabel, "p1");
  assert.equal(models.entries[0].provider, "p1");
  assert.equal(models.entries[1].provider, "p2");

  const providers = leaderboard(current, previous, { groupBy: "provider", includeCache: false, limit: 0 });
  assert.deepEqual(providers.entries.map((entry) => [entry.name, entry.tokens, entry.sublabel]), [
    ["p1", 150, "1 model"],
    ["p2", 50, "2 models"],
  ]);

  const noPrevious = leaderboard(current, null, { groupBy: "model", includeCache: false, limit: 0 });
  assert.equal(noPrevious.hasPrevious, false);
  assert.equal(noPrevious.entries[0].change.kind, "none");
  assert.equal(noPrevious.entries[0].change.label, "—");

  const emptyPrevious = leaderboard(current, [], { groupBy: "model", includeCache: false, limit: 0 });
  assert.equal(emptyPrevious.entries[0].change.kind, "new");

  assert.deepEqual(compareChange(0, 0, true), { kind: "flat", direction: "flat", pct: 0, label: "0%" });
  assert.equal(compareChange(10, 0, true).kind, "new");
  assert.equal(compareChange(0, 10, true).label, "-100.0%");
  assert.equal(compareChange(10, 10, true).label, "0%");
  assert.equal(compareChange(10, 10, false).label, "—");
});

test("dashboard scopes filters to model usage while the heatmap covers everything", () => {
  const value = snapshot({
    rows: [
      row({ day: "2024-01-08", session: "s1", model: "model-a", provider: "p1", tokens: { input: 100, output: 0 } }),
      row({ day: "2024-01-09", session: "s2", model: "model-b", provider: "p2", tokens: { input: 300, output: 0 } }),
    ],
  });
  const derived = deriveDashboard(value, {
    filters: { provider: "all", model: "model-a" },
    period: "all",
    year: 2024,
    heatmapMode: "daily",
    selectedDay: "2024-01-09",
    today: "2024-01-10",
  });
  // Token usage is unfiltered: both days stay in the heatmap and metrics.
  assert.equal(derived.lifetime.total, 400);
  assert.equal(derived.heatmap.windowTotal, 400);
  assert.equal(derived.selectedTotals.total, 300, "day detail follows the heatmap, not the filter");
  // Model usage is filtered: only model-a leads.
  assert.deepEqual(derived.leaders.entries.map((entry) => entry.name), ["model-a"]);
  assert.deepEqual(derived.modelSeries.models, ["model-a"]);
});

test("model series stacks weekly tokens by top model with an Other bucket", () => {
  const rows = [
    row({ day: "2024-01-02", model: "model-a", tokens: { input: 100, output: 0 } }),
    row({ day: "2024-01-03", model: "model-b", tokens: { input: 200, output: 0 } }),
    row({ day: "2024-01-09", model: "model-a", tokens: { input: 300, output: 0 } }),
    row({ day: "2024-01-10", model: "model-c", tokens: { input: 50, output: 0 } }),
    row({ day: "2023-12-01", model: "model-a", tokens: { input: 999, output: 0 } }),
  ];

  const series = buildModelSeries(rows, { endDay: "2024-01-14", weeks: 4, weekStartsOn: 0, limit: 2, includeCache: false });
  assert.equal(series.weeks.length, 4);
  assert.deepEqual(series.weeks.map((week) => week.start), ["2023-12-24", "2023-12-31", "2024-01-07", "2024-01-14"]);
  // model-c falls outside the top 2 and becomes Other; the out-of-window row is ignored.
  assert.deepEqual(series.models, ["model-a", "model-b", "Other"]);
  assert.equal(series.windowTotal, 650);
  assert.equal(series.maxTotal, 350);
  assert.deepEqual(series.weeks[1].segments, [
    { name: "model-a", tokens: 100 },
    { name: "model-b", tokens: 200 },
  ]);
  assert.deepEqual(series.weeks[2].segments, [
    { name: "model-a", tokens: 300 },
    { name: "Other", tokens: 50 },
  ]);
  assert.deepEqual(series.weeks[0].segments, []);
  assert.equal(series.range.end, "2024-01-14");

  const noOther = buildModelSeries(rows.slice(0, 2), { endDay: "2024-01-14", weeks: 3, weekStartsOn: 0, includeCache: false });
  assert.deepEqual(noOther.models, ["model-b", "model-a"]);
});

test("chart follows the same calendar range as the selected model-usage period", () => {
  const value = snapshot({ rows: [
    row({ day: "2026-01-05", tokens: { input: 7 } }),
    row({ day: "2026-10-15", tokens: { input: 11 } }),
    row({ day: "2026-11-05", tokens: { input: 13 } }),
    row({ day: "2025-06-12", tokens: { input: 17 } }),
  ] });
  for (const [period, unit, total] of [["week", "day", 13], ["month", "day", 13], ["year", "month", 31]]) {
    const derived = deriveDashboard(value, { today: "2026-11-06", period });
    assert.equal(derived.modelSeries.windowTotal, total);
    assert.equal(derived.modelSeries.windowTotal, derived.totals.total);
    assert.deepEqual(derived.modelSeries.range, { start: derived.range.start, end: derived.range.end });
    assert.equal(derived.modelSeries.bucketUnit, unit);
  }
  const past = deriveDashboard(value, { today: "2026-11-06", period: "year", year: 2025 });
  assert.equal(past.modelSeries.weeks.length, 12);
  assert.equal(past.modelSeries.windowTotal, 17);
  assert.deepEqual(past.modelSeries.range, { start: "2025-01-01", end: "2025-12-31" });
});

test("compact values cover billions and exact values keep every digit", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1000), "1K");
  assert.equal(formatCompact(1234), "1.23K");
  assert.equal(formatCompact(12345), "12.3K");
  assert.equal(formatCompact(123456), "123K");
  assert.equal(formatCompact(1234567), "1.23M");
  assert.equal(formatCompact(1234567890), "1.23B");
  assert.equal(formatCompact(999999999), "1B");
  assert.equal(formatCompact(999999), "1M");
  assert.equal(formatCompact(1000000000000), "1T");
  assert.equal(formatInt(1234567890), "1,234,567,890");
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(900), "<1s");
  assert.equal(formatDuration(65000), "1m");
  assert.equal(formatDuration(3660000), "1H 1m");
  assert.equal(formatDuration(90000000), "1D 1H");
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(intensityLevel(0, 100), 0);
  assert.equal(intensityLevel(25, 100), 1);
  assert.equal(intensityLevel(100, 100), 4);
});

test("config and year helpers are defensive", () => {
  const mapping = { session: "session.id", tokens: { input: "usage.input" }, nested: { keep: true } };
  const config = normalizeConfig({
    profile: { name: "Ada", handle: "ada", avatar: "" },
    palette: "purple",
    includeCache: false,
    weekStartsOn: 1,
    refreshSeconds: 2,
    sources: [{ id: "custom", adapter: "custom", enabled: true, roots: ["~/.custom"], mapping }],
    extra: { preserved: true },
  });
  assert.equal(config.palette, "purple");
  assert.equal(config.includeCache, false);
  assert.equal(config.weekStartsOn, 1);
  assert.equal(config.refreshSeconds, 30);
  assert.deepEqual(config.sources[0].mapping, mapping);
  assert.deepEqual(config.extra, { preserved: true });
  assert.deepEqual(availableYears([row({ day: "2023-01-01" }), row({ day: "2024-01-01" })], "2025-01-01"), [2025, 2024, 2023]);

  const defaults = normalizeConfig({});
  assert.deepEqual(defaults.sources.map((source) => source.adapter), ["pi", "codex", "opencode", "claude", "antigravity"]);
  assert.equal(defaults.sources.some((source) => source.adapter === "claude"), true);
  assert.deepEqual(normalizeConfig({ sources: [] }).sources, [], "an explicit empty source list is preserved");
  const claude = normalizeConfig({ sources: [{ id: "claude", label: "Claude Code", adapter: "claude", enabled: true, roots: ["~/.claude/projects"] }] });
  assert.equal(claude.sources[0].adapter, "claude", "explicit Claude configs remain readable");
});

function snapshot(overrides = {}) {
  return {
    version: 1,
    generatedAt: "2024-01-10T12:00:00Z",
    lastScanAt: "2024-01-10T12:00:00Z",
    config: {
      profile: { name: "Ada", handle: "ada", avatar: "mods/insights/avatar.png" },
      palette: "blue",
      includeCache: true,
      weekStartsOn: 0,
      refreshSeconds: 60,
      sources: [{ id: "pi", label: "Pi", adapter: "pi", enabled: true, roots: ["~/.pi"] }],
    },
    rows: [
      row({ day: "2024-01-01", session: "s1", model: "model-a", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      row({ day: "2024-01-02", session: "s2", model: "model-b", tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ],
    stats: { files: 2, filesRead: 2, bytesRead: 100, unchangedFiles: 0, errors: 0 },
    warnings: [],
    ...overrides,
  };
}

test("dashboard cache reuses facet-aware derivation until snapshot or state changes", () => {
  const value = snapshot();
  const options = {
    filters: { source: "all", provider: "all", model: "all", project: "all" },
    period: "all",
    year: 2024,
    heatmapMode: "daily",
    leaderboardGroup: "model",
    selectedDay: "2024-01-02",
    today: "2024-01-10",
  };
  let calls = 0;
  const cache = createDashboardCache((snap, viewOptions) => {
    calls += 1;
    return deriveDashboard(snap, viewOptions);
  });

  const first = cache.read(value, options);
  const repeated = cache.read(value, { ...options, filters: { ...options.filters } });
  assert.equal(calls, 1);
  assert.equal(repeated, first);
  assert.equal(repeated.facets.model, first.facets.model);
  assert.deepEqual(Object.keys(first.facets).sort(), ["machine", "model", "project", "provider", "source"]);
  assert.equal(first.facets.model.total, 30);
  assert.deepEqual(first.years, [2024]);
  assert.equal(cache.peek(value, options), first);
  assert.equal(cache.peek(value, { ...options, period: "week" }), null);
  assert.equal(calls, 1, "peek never computes analytics");

  const filtered = cache.read(value, { ...options, filters: { ...options.filters, model: "model-a" } });
  assert.notEqual(filtered, first);
  assert.equal(calls, 2);
  assert.equal(cache.read(value, { ...options, filters: { model: "model-a", source: "all", provider: "all", project: "all" } }), filtered);
  assert.equal(calls, 2);

  cache.read(value, { ...options, selectedDay: "2024-01-01" });
  assert.equal(calls, 3);
  cache.read(value, { ...options, today: "2024-01-11" });
  assert.equal(calls, 4);

  const nextSnapshot = { ...value, rows: [...value.rows] };
  cache.read(nextSnapshot, options);
  assert.equal(calls, 5);

  value.config = { ...value.config, includeCache: false };
  cache.read(value, options);
  assert.equal(calls, 6);

  for (const change of [{ period: "week" }, { year: 2023 }, { heatmapMode: "weekly" }, { leaderboardGroup: "provider" }]) {
    cache.read(value, { ...options, ...change });
  }
  assert.equal(calls, 10);

  cache.invalidate();
  cache.read(value, options);
  assert.equal(calls, 11);
});
