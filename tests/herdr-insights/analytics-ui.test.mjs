import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(new URL("../../herdr-insights/mods/insights/main.js", import.meta.url), "utf8");
const analyticsSource = await readFile(new URL("../../herdr-insights/mods/insights/analytics.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../../herdr-insights/mods/insights/ui.js", import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const analyticsUrl = dataUrl(analyticsSource);
const analytics = await import(analyticsUrl);
const analyticsNames = Object.keys(analytics).join(", ");
const { buildHeatmap, compactDashboard, deriveDashboard } = analytics;

function fakeNativeElement() {
  const node = { calls: [], childNodes: [], style: {} };
  let element;
  const methods = {
    child(value) { node.childNodes.push(value); return element; },
    children(values) { node.childNodes.push(...values); return element; },
    when(condition, branch) { if (condition) branch(element); return element; },
    w(value) { node.style.width = value; return element; },
    whitespace_nowrap() { node.style.whitespace = "nowrap"; return element; },
    items_start() { node.style.alignItems = "start"; return element; },
    flex_wrap() { node.style.flexWrap = "wrap"; return element; },
    min_w(value) { node.style.minWidth = value; return element; },
    flex_basis(value) { node.style.flexBasis = value; return element; },
    flex_grow(value) { node.style.flexGrow = value; return element; },
  };
  element = new Proxy(node, {
    get(target, property) {
      if (property in methods) return methods[property];
      if (property in target) return target[property];
      if (typeof property === "symbol") return undefined;
      return (...args) => {
        node.calls.push([property, args]);
        return element;
      };
    },
  });
  return element;
}

globalThis.__insightsTestNative = { create: fakeNativeElement };

globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };

globalThis.__insightsTestInputState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.inputStates += 1;
    const state = {
      text: String(options.value ?? ""),
      released: false,
      handlers: new Map(),
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on(name, handler) { state.handlers.set(name, handler); },
      release() { state.released = true; },
    };
    return state;
  },
};

globalThis.__insightsTestEditorState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.editorStates += 1;
    const state = {
      text: String(options.value ?? "{}"),
      released: false,
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on() {},
      release() { state.released = true; },
    };
    return state;
  },
};

const transformedUi = uiSource
  .replace(/^import \{ div \} from "gpui-kit";$/m, `const div = () => globalThis.__insightsTestNative.create("div");`)
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    `const v_flex = () => globalThis.__insightsTestNative.create("v_flex");
const h_flex = () => globalThis.__insightsTestNative.create("h_flex");
const Button = { new: (id) => globalThis.__insightsTestNative.create("Button") };
const Toggle = { new: (id) => globalThis.__insightsTestNative.create("Toggle") };`,
  );
const uiUrl = dataUrl(transformedUi);
const ui = await import(uiUrl);
const uiNames = Object.keys(ui).join(", ");

const transformedMain = mainSource
  .replace(/^import \{ View, div, svg \} from "gpui-kit";$/m, `const View = class View {};
const div = () => globalThis.__insightsTestNative.create("div");
const svg = () => globalThis.__insightsTestNative.create("svg");`)
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    `const InputState = globalThis.__insightsTestInputState;
const EditorState = globalThis.__insightsTestEditorState;
const v_flex = () => globalThis.__insightsTestNative.create("v_flex");
const h_flex = () => globalThis.__insightsTestNative.create("h_flex");
const Button = { new: (id) => globalThis.__insightsTestNative.create("Button") };`,
  )
  .replace(
    /^import \{[^}]*\} from "herdr";$/m,
    `const appHome = () => "/app";
const home = () => "/home";
const theme = () => ({});
const settings = () => ({});
const nextCommand = () => globalThis.__insightsTestHerdr.nextCommand();
const exec = (...args) => globalThis.__insightsTestHerdr.exec(...args);
const readTextFile = (...args) => globalThis.__insightsTestHerdr.readTextFile(...args);
const panes = () => globalThis.__insightsTestHerdr.panes();
const props = () => globalThis.__insightsTestHerdr.props();
const run = (...args) => globalThis.__insightsTestHerdr.run(...args);
const spaces = () => globalThis.__insightsTestHerdr.spaces();`,
  )
  .replace(
    /^import \{[\s\S]*?\} from "\.\/analytics\.js";$/m,
    `const { ${analyticsNames} } = await import("${analyticsUrl}");`,
  )
  .replace(
    /^import \{[\s\S]*?\} from "\.\/ui\.js";$/m,
    `const { ${uiNames} } = await import("${uiUrl}");`,
  );
const { default: Insights, heatmapMetrics, modelLogo, providerLogo, usageLogo } = await import(dataUrl(transformedMain));

function optionArgument(args) {
  const index = args.indexOf("--options");
  return index >= 0 ? JSON.parse(args[index + 1]) : {};
}

function compactSnapshotFor(snapshot) {
  const { rows, ...rest } = snapshot;
  return { ...rest, rowCount: rows.length };
}

function presentationFor(snapshot, options, command = "snapshot") {
  return {
    version: 1,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshotFor(snapshot),
    dashboard: compactDashboard(deriveDashboard(snapshot, options)),
    error: null,
  };
}

function useHerdr({ readTextFile, execResult } = {}) {
  const state = { commands: [], execCalls: [], panes: [], props: {}, runtimeReads: [], spaces: [] };
  state.herdr = {
    appHome: () => "/app",
    home: () => "/home",
    theme: () => ({}),
    settings: () => ({}),
    nextCommand: () => new Promise(() => {}),
    panes: () => state.panes,
    props: () => state.props,
    run: (...args) => state.commands.push(args),
    spaces: () => state.spaces,
    readTextFile: async (path) => {
      state.runtimeReads.push(path);
      return readTextFile ? readTextFile(path) : null;
    },
    exec: async (command, args) => {
      state.execCalls.push({ command, args });
      if (execResult) return execResult(command, args, state);
      const options = optionArgument(args);
      const payload = presentationFor(savedSnapshot(), options, args[1] ?? "snapshot");
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    },
  };
  globalThis.__insightsTestHerdr = state.herdr;
  return state;
}

function liveCx() {
  const calls = { notify: 0, spawn: 0, timers: [], after: [] };
  const cx = {
    calls,
    notify() { calls.notify += 1; },
    spawn(fn) {
      calls.spawn += 1;
      let cancelled = false;
      const done = Promise.resolve().then(() => (cancelled ? undefined : fn(cx)));
      return { cancel() { cancelled = true; return done; }, done };
    },
    timer: {
      every(ms, fn) {
        const timer = { ms, fn, cancel() {} };
        calls.timers.push(timer);
        return timer;
      },
      after(ms, fn) {
        const timer = {
          ms,
          fn: () => fn(cx),
          cancelled: false,
          cancel() { timer.cancelled = true; },
        };
        calls.after.push(timer);
        return timer;
      },
    },
  };
  calls.runAfter = async () => {
    const pending = calls.after.splice(0);
    for (const timer of pending) {
      if (!timer.cancelled) timer.fn();
    }
    await flush();
  };
  return { cx, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeCx() {
  const calls = { notify: 0, spawn: 0, after: [] };
  return {
    calls,
    notify() { calls.notify += 1; },
    spawn() { calls.spawn += 1; return { cancel() {} }; },
    timer: {
      every() { return { cancel() {} }; },
      after() {
        const timer = { cancel() {} };
        calls.after.push(timer);
        return timer;
      },
    },
  };
}

function blankInstance() {
  const instance = Object.create(Insights.prototype);
  instance.loading = false;
  instance.saving = false;
  instance.error = null;
  instance.snapshot = null;
  instance.runtimeReady = true;
  instance.runtimeError = null;
  instance.nodeBinary = "/test/node";
  instance.year = 2024;
  instance.selectedDay = "2024-01-10";
  instance.period = "all";
  instance.filters = { provider: "all", model: "all" };
  instance.heatmapMode = "daily";
  instance.years = [2024];
  instance.dashboard = null;
  instance.dashboardKey = null;
  instance.dashboardPending = null;
  instance.dashboardError = null;
  instance.dashboardTimer = null;
  instance.dashboardTask = null;
  instance.dashboardQueued = false;
  instance.dashboardGeneration = 0;
  instance.refreshWatchdog = null;
  instance.saveWatchdog = null;
  instance.presenterPath = () => "/app/mods/insights/presenter.mjs";
  instance.storePath = () => "/app/data/insights/insights.json";
  return instance;
}

function savedSnapshot() {
  return {
    version: 1,
    generatedAt: "2024-01-10T12:00:00Z",
    lastScanAt: "2024-01-10T12:00:00Z",
    config: {
      profile: { name: "Saved", handle: "saved", avatar: "" },
      includeCache: true,
      weekStartsOn: 0,
      refreshSeconds: 60,
      sources: [{ id: "saved", label: "Saved", adapter: "saved", enabled: true, roots: ["~/saved"] }],
    },
    rows: [],
    stats: { files: 0, filesRead: 0, bytesRead: 0, unchangedFiles: 0, errors: 0 },
    warnings: [],
  };
}

function configDraft() {
  return {
    profile: { name: "Draft", handle: "draft", avatar: "mods/insights/draft.png" },
    includeCache: false,
    weekStartsOn: 1,
    refreshSeconds: 120,
    customTopLevel: { keep: true },
    sources: [{
      id: "custom",
      label: "Custom",
      adapter: "custom",
      enabled: true,
      roots: ["~/custom"],
      mapping: { input: "usage.input" },
      extra: { keep: true },
    }],
  };
}

test("native mod keeps timers and shell use inside the Herdr contract", () => {
  assert.doesNotMatch(mainSource, /\bsetTimeout\b/);
  assert.doesNotMatch(mainSource, /\bsetInterval\b/);
  assert.doesNotMatch(mainSource, /this\.cx\b/);
  assert.doesNotMatch(mainSource, /\bsh\s*,\s*\[/);
  assert.doesNotMatch(mainSource, /--rebuild/);
  assert.match(mainSource, /readTextFile\(this\.runtimePath\(\)\)/);
  assert.match(mainSource, /mods\/insights\/runtime\.json/);
  assert.equal((mainSource.match(/exec\(this\.nodeBinary, \[/g) ?? []).length, 3);
  assert.match(mainSource, /presenter\.mjs/);
  assert.match(mainSource, /"prepare"/);
  assert.match(mainSource, /timer\.after\(0/);
  assert.match(mainSource, /configure/);
  assert.match(mainSource, /--config/);
  assert.match(mainSource, /on_size_change/);
  assert.match(mainSource, /overflow_hidden/);
  assert.match(mainSource, /nextCommand/);
  assert.match(mainSource, /name === "refresh"/);
  assert.match(mainSource, /name === "settings"/);
  assert.match(mainSource, /name === "dashboard"/);
  assert.match(mainSource, /sourceStats/);
  assert.match(mainSource, /EditorState\.new/);
  assert.match(mainSource, /result\.code !== 0/);
  assert.match(mainSource, /\.release\(\)/);
  assert.match(mainSource, /from "\.\/ui\.js"/);
  assert.doesNotMatch(mainSource, /smallButton|detailStat|togglePill|shadow_md/);
  assert.doesNotMatch(mainSource, /rounded\([12][0-9]\)/);
});

test("analytics stays host-free and the UI keeps configuration JSON editable", () => {
  assert.doesNotMatch(analyticsSource, /from\s+["']herdr["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-kit["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-base["']/);
  assert.match(mainSource, /Configuration JSON/);
  assert.match(mainSource, /Save configuration/);
  assert.doesNotMatch(mainSource, /(^|[^.\w])localStorage\b/);
});

test("toolbar init returns before runtime, collector, command, timer or editor setup", async () => {
  const state = useHerdr();
  globalThis.__insightsTestHostCalls.inputStates = 0;
  globalThis.__insightsTestHostCalls.editorStates = 0;
  const { cx, calls } = liveCx();
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init(undefined, cx);

  assert.equal(instance.toolbarMode, true);
  assert.deepEqual(state.runtimeReads, []);
  assert.deepEqual(state.execCalls, []);
  assert.deepEqual(calls.timers, []);
  assert.equal(calls.spawn, 0);
  assert.equal(globalThis.__insightsTestHostCalls.inputStates, 0);
  assert.equal(globalThis.__insightsTestHostCalls.editorStates, 0);
  assert.equal(instance.commandTask, undefined);
  assert.equal(instance.runtimeTask, undefined);
  assert.equal(instance.dashboard, undefined);
  assert.doesNotThrow(() => instance.close());
  assert.equal(instance.closed, true);
});

test("toolbar render is only the native Insights button and has no side effects", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const root = instance.render();
  const button = root.childNodes[0];

  assert.equal(button.childNodes[1], "Insights");
  assert.equal(button.calls.find(([name]) => name === "id")[1][0], "insights-open");
  for (const [method, value] of [["h", 26], ["px", 8], ["gap", 5], ["rounded", 6], ["text_size", 12]]) {
    assert.ok(button.calls.some(([name, args]) => name === method && args[0] === value),
      `${method} matches Herdr's native toolbar control`);
  }
  assert.deepEqual(state.commands, [], "render must have no side effects");

  let stopped = false;
  button.calls.find(([name]) => name === "on_mouse_down")[1][1]({}, {
    stop_propagation() { stopped = true; },
  });
  assert.equal(stopped, true);
  assert.doesNotMatch(mainSource, /mods\/insights-launcher/);
  assert.doesNotMatch(mainSource, /\blayout\(/);
});

test("toolbar reuses the active space's dashboard and reveals it behind another pane's zoom", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }];
  state.panes = [
    { pane: "terminal", mod: "terminal", tab: "t2", zoomed: true },
    { pane: "dashboard", mod: "insights", tab: "t2", focused: false, zoomed: false },
  ];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const button = instance.render().childNodes[0];
  const click = button.calls.find(([name]) => name === "on_click")[1][0];

  click();
  click();
  assert.deepEqual(state.commands, [
    ["pane.zoom", { pane: "terminal" }],
    ["pane.focus", { pane: "dashboard" }],
    ["pane.zoom", { pane: "terminal" }],
    ["pane.focus", { pane: "dashboard" }],
  ]);
});

test("toolbar keeps an already zoomed dashboard and opens a tab only when the space has none", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [{ pane: "dashboard", mod: "insights", tab: "t1", zoomed: true }];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const click = instance.render().childNodes[0].calls.find(([name]) => name === "on_click")[1][0];

  click();
  assert.deepEqual(state.commands, [["pane.focus", { pane: "dashboard" }]]);

  state.panes = [];
  state.commands.length = 0;
  click();
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]]);

  state.spaces = [
    { id: "s1", active: true, tabs: [{ id: "t1" }] },
    { id: "s2", active: false, tabs: [{ id: "t2" }] },
  ];
  state.panes = [{ mod: "insights", tab: "t2" }];
  state.commands.length = 0;
  click();
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]],
    "an Insights tab in another space never satisfies the current space");
});

test("init reads the runtime config once and waits before the first snapshot", async () => {
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  const state = useHerdr({ readTextFile: () => pendingRead });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  assert.deepEqual(state.runtimeReads, ["/app/mods/insights/runtime.json"]);
  assert.equal(state.execCalls.length, 0, "no collector may start before runtime.json resolves");
  assert.equal(calls.timers.length, 0, "no poll may start before runtime.json resolves");

  instance.refresh(cx);
  await flush();
  assert.equal(state.execCalls.length, 0, "a manual refresh must also wait for runtime resolution");

  finishRead(null);
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, "node", "manual-copy installs fall back to node on PATH");
  assert.equal(state.execCalls.length, 1);
  assert.equal(state.execCalls[0].command, "node");
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(calls.timers.length, 2, "the refresh interval plus the scan progress poll");

  instance.refresh(cx);
  await flush();
  await flush();
  assert.equal(state.runtimeReads.length, 1, "refresh must not reread runtime.json");
  assert.equal(state.execCalls.length, 2);
  assert.equal(state.execCalls[1].command, "node");
  instance.close();
});

test("snapshot and configure both launch the installed Node executable", async () => {
  const node = "/opt/homebrew/opt/node@24/bin/node";
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node }) });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, node);
  assert.equal(state.execCalls.length, 1);

  instance.saveConfig(cx);
  await flush();
  await flush();
  await flush();
  assert.deepEqual(state.execCalls.map((call) => call.command), [node, node]);
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(state.execCalls[1].args[1], "configure");
  instance.close();
});

test("invalid runtime config fails clearly without launching the collector", async () => {
  const cases = [
    ['{"node":"https://example.test/node"}', /URL/],
    ['{"node":"/usr/local/bin/node\\u0000"}', /control/],
    ['{"node":"   "}', /empty/],
    ["[]", /JSON object/],
    ['{"node":123}', /node string/],
    ["not json", /not valid JSON/],
  ];

  for (const [raw, reason] of cases) {
    const state = useHerdr({ readTextFile: () => raw });
    const { cx, calls } = liveCx();
    const instance = new Insights();
    instance.init({}, cx);

    await flush();
    await flush();
    assert.equal(state.execCalls.length, 0, raw);
    assert.equal(instance.nodeBinary, null, raw);
    assert.equal(instance.runtimeReady, true, raw);
    assert.match(instance.error, /runtime\.json/, raw);
    assert.match(instance.error, reason, raw);
    assert.equal(calls.timers.length, 0, raw);
    instance.close();
  }
});

test("refresh and configure share one single-flight guard", () => {
  const instance = blankInstance();
  const cx = fakeCx();

  instance.refresh(cx);
  assert.equal(instance.loading, true);
  assert.equal(instance.busy(), true);
  assert.equal(cx.calls.spawn, 1);
  assert.equal(cx.calls.notify, 1);

  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "a snapshot or configure call must not start while refresh is in flight");

  instance.loading = false;
  instance.saving = true;
  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "refresh and configure must not start while save is in flight");
  assert.equal(instance.busy(), true);

  instance.saving = false;
  assert.equal(instance.busy(), false);
  assert.match(mainSource, /button\("insights-refresh",[^;]*?disabled: this\.busy\(\)/);
  assert.match(mainSource, /button\("ins-config-save",[\s\S]*?disabled: this\.busy\(\)/);
  assert.doesNotMatch(mainSource, /insights-save-profile|profileDirty|AvatarImage|nameInput|handleInput|avatarInput/);
});

test("dashboard render uses the precomputed presentation and builds closed filter menus lazily", () => {
  assert.match(mainSource, /const derived = this\.dashboard;/);
  assert.doesNotMatch(mainSource, /dashboardCache|updateDashboard|deriveDashboard/);
  assert.doesNotMatch(mainSource, /\b(buildHeatmap|facetStats|filterRows|filterRowsByRange|leaderboard|peakDay|streakStats|sumTokens)\(/);
  assert.match(mainSource, /if \(this\.openFilter === id && this\.openOptions\)/);
  assert.match(mainSource, /this\.openOptions = open \? buildFacetOptions/);
  assert.match(mainSource, /menu\.content\(this\.filterMenuContent/);
  assert.doesNotMatch(mainSource, /const (source|provider|model|project)Options = buildFacetOptions/);
  assert.doesNotMatch(mainSource, /safeAvatarPath|AvatarImage|AvatarFallback|Profile/);
  assert.match(mainSource, /scheduleDashboard\(clickCx, \{ force: true \}\)/);
});

test("heatmap month labels keep their spans while partial labels cannot wrap", () => {
  const instance = blankInstance();
  const heatmap = buildHeatmap([], { endDay: "2024-01-28", weeks: 53, weekStartsOn: 0 });
  assert.equal(heatmap.months[0].span, 1, "the fixture must start with a partial month");

  const totals = {
    total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    sessions: 0, messages: 0, longestTaskMs: 0,
  };
  const card = instance.heatmapCard(
    { background: "#101010" },
    { palette: "blue", includeCache: true },
    heatmap,
    heatmap.range.dataEnd,
    0,
    totals,
    null,
  );
  const metrics = heatmapMetrics(undefined, heatmap.weeks.length);
  const grid = card.childNodes[1].childNodes[0];
  const monthNodes = grid.childNodes[0].childNodes.slice(1);
  assert.equal(monthNodes.length, heatmap.months.length);

  heatmap.months.forEach((month, index) => {
    const node = monthNodes[index];
    assert.equal(node.style.width, month.span * metrics.weekWidth, `${month.label} keeps its week span`);
    if (month.span === 1) {
      assert.deepEqual(node.childNodes, [], "a one-week partial month has no label to wrap");
    } else {
      assert.deepEqual(node.childNodes, [month.label]);
      assert.equal(node.style.whitespace, "nowrap", `${month.label} must not wrap`);
    }
  });
});

test("heatmap grows on wide views and prefers the newest weeks when narrow", () => {
  const wide = heatmapMetrics(1600, 53);
  const narrow = heatmapMetrics(480, 53);
  assert.ok(wide.cell > narrow.cell, "wider views get larger cells");
  assert.ok(wide.cell <= 20, "cells stay capped");
  assert.equal(wide.centered, true);
  assert.equal(narrow.centered, false);
  assert.equal(wide.weekWidth, wide.cell + 2);
  assert.match(mainSource, /\.when\(metrics\.centered, \(el\) => el\.justify_center\(\)\)/);
  assert.match(mainSource, /\.when\(!metrics\.centered, \(el\) => el\.justify_end\(\)\)/,
    "an overflowing grid is end-aligned so recent weeks stay visible");
  assert.match(mainSource, /h_flex\(\)\.w_full\(\)\.overflow_hidden\(\)[\s\S]{0,200}metrics\.centered/,
    "the grid is clipped, not scrolled, so end alignment applies");
});

test("dashboard is divided into token and model usage sections", () => {
  assert.match(mainSource, /sectionHeader\("Token usage"/);
  assert.match(mainSource, /sectionHeader\("Model usage"/);
  assert.match(mainSource, /cardHeader\("Tokens History", null, c\)/);
  assert.doesNotMatch(mainSource, /53 weeks · ends/);
  assert.match(mainSource, /"Model Usage"/);
  assert.doesNotMatch(mainSource, /Contribution history|Usage leaders/);
  // Period and facet filters belong to the model usage section only.
  assert.ok(mainSource.indexOf('sectionHeader("Model usage"') < mainSource.indexOf("this.filtersBar"));
  assert.ok(mainSource.indexOf("this.filtersBar") > mainSource.indexOf("this.heatmapCard"));
  assert.match(mainSource, /filterMenu\("machine"/);
  assert.match(mainSource, /filterMenu\("source"/);
  assert.doesNotMatch(mainSource, /filterMenu\("project"|breakdownCard|selectedDetail/);
});

test("usage logos prefer model marks, then provider marks, then initials", async () => {
  assert.equal(modelLogo("deepseek-v4.1-flash"), "deepseek.svg");
  assert.equal(modelLogo("xai.grok-4.6"), "xai.svg");
  assert.equal(modelLogo("grok-4.6"), "xai.svg");
  assert.equal(modelLogo("claude-opus-5"), "anthropic.svg");
  assert.equal(modelLogo("gpt-6.1"), "openai.svg");
  assert.equal(modelLogo("ollama"), "ollama.svg");
  assert.equal(modelLogo("ollama/qwen2.5"), "ollama.svg");
  assert.equal(modelLogo("ollama/mistral"), "mistralai.svg");
  assert.equal(modelLogo("ollama/llama3"), "meta.svg");
  assert.equal(modelLogo("llama3.2"), "meta.svg");
  assert.equal(modelLogo("codellama:7b"), "meta.svg");
  assert.equal(modelLogo("tinyllama"), "meta.svg");
  assert.equal(modelLogo("moonshot-kimi"), null);

  assert.equal(usageLogo("deepseek-v4.1", "openai"), "deepseek.svg");
  assert.equal(usageLogo("grok-4.6", "openrouter"), "xai.svg");
  assert.equal(usageLogo("custom-model", "openai"), "openai.svg");
  assert.equal(usageLogo("custom-model", "moonshot"), null);

  assert.equal(providerLogo("openai"), "openai.svg");
  assert.equal(providerLogo("amazon-bedrock"), "amazonaws.svg");
  assert.equal(providerLogo("bedrock-mantle"), "amazonaws.svg");
  assert.equal(providerLogo("opencode-go"), "opencode.svg");
  assert.equal(providerLogo("xai"), "xai.svg");
  assert.equal(providerLogo("deepseek"), "deepseek.svg");
  assert.equal(providerLogo("moonshot"), null);
  assert.equal(providerLogo("unknown"), null);
  assert.equal(providerLogo(null), null);

  assert.match(mainSource, /usageLogo\(entry\.name, entry\.provider\)/);
  assert.match(mainSource, /initials\(entry\.name, 1\)/);
  assert.doesNotMatch(mainSource, /initials\(entry\.name, 2\)/);
  assert.doesNotMatch(mainSource, /"x\.svg"/);
  await Promise.all([
    "amazonaws.svg",
    "anthropic.svg",
    "deepseek.svg",
    "googlegemini.svg",
    "meta.svg",
    "mistralai.svg",
    "ollama.svg",
    "openai.svg",
    "opencode.svg",
    "xai.svg",
  ].map((file) => readFile(new URL(`../../herdr-insights/mods/insights/logos/${file}`, import.meta.url))));
});

test("model usage leaderboard is models-only with ranked change rows", () => {
  assert.doesNotMatch(mainSource, /ins-leaders-group|leaderboardGroup|insights\.group/);
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = [
    { day: "2024-01-10", model: "model-a", provider: "p-one", tokens: { input: 100, output: 50 } },
    { day: "2024-01-10", model: "model-b", provider: "p-two", tokens: { input: 40, output: 10 } },
  ];
  const leaders = analytics.leaderboard(rows, null, { groupBy: "model", includeCache: true });
  const card = instance.leaderboardCard(c, leaders, { label: "All time" });
  const column = card.childNodes[1].childNodes[0];
  const firstRow = column.childNodes[0];

  assert.equal(firstRow.childNodes.length, 4, "rank, avatar, name, and value only; no share bar");
  assert.deepEqual(firstRow.childNodes[0].childNodes, ["1."]);
  const nameColumn = firstRow.childNodes[2];
  assert.deepEqual(nameColumn.childNodes[0].childNodes, ["model-a"]);
  assert.deepEqual(nameColumn.childNodes[1].childNodes, ["by p-one"]);
  const valueColumn = firstRow.childNodes[3];
  assert.deepEqual(valueColumn.childNodes[0].childNodes, ["150 tokens"]);
  assert.deepEqual(valueColumn.childNodes[1].childNodes, ["—"], "no previous period shows a dash");
});

test("model usage wraps into columns instead of switching on a pane width", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = Array.from({ length: 10 }, (_, index) => ({
    day: "2024-01-10",
    model: `model-${index}`,
    provider: "p-one",
    tokens: { input: 100 - index, output: 10 },
  }));
  const leaders = analytics.leaderboard(rows, null, { groupBy: "model", includeCache: true });

  const grid = instance.leaderboardCard(c, leaders, { label: "All time" }).childNodes[1];
  assert.equal(grid.style.flexWrap, "wrap", "columns wrap instead of using a width breakpoint");
  assert.deepEqual(grid.childNodes.map((column) => column.childNodes.length), [5, 5]);
  for (const column of grid.childNodes) {
    assert.equal(column.style.flexBasis, 300, "preferred width controls wrapping");
    assert.equal(column.style.flexGrow, 1, "columns share remaining space");
    assert.equal(column.style.minWidth, 0, "a column can shrink below its basis in narrow split panes");
  }

  const single = analytics.leaderboard(rows.slice(0, 1), null, { groupBy: "model", includeCache: true });
  const singleGrid = instance.leaderboardCard(c, single, { label: "All time" }).childNodes[1];
  assert.equal(singleGrid.childNodes.length, 1, "an empty second column is not rendered");
});

test("loading state shows live scan progress and scan status lives in settings", () => {
  assert.doesNotMatch(mainSource, /Reading local session history|collector and presentation helper|Preparing the compact dashboard|Initializing the native source|bottomGrid/);
  assert.match(mainSource, /children\(\[preferences, sources, scan, json\]\)/);

  const instance = blankInstance();
  instance.loading = true;
  instance.scanProgress = { processed: 42, total: 1183, file: "/home/u/.codex/sessions/a.jsonl" };
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const card = instance.initialState(c);
  assert.deepEqual(card.childNodes[1].childNodes, ["Scanning 42 of 1,183 files"]);
  assert.deepEqual(card.childNodes[2].childNodes, ["/home/u/.codex/sessions/a.jsonl"]);

  instance.scanProgress = null;
  const quiet = instance.initialState(c);
  assert.equal(quiet.childNodes.length, 1, "no static body or detail while progress is unknown");
});

test("model chart card renders stacked weekly bars, axis labels and a legend", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = [
    { day: "2024-01-02", model: "model-a", tokens: { input: 100, output: 0 } },
    { day: "2024-01-09", model: "model-b", tokens: { input: 300, output: 0 } },
    { day: "2024-01-09", model: "model-a", tokens: { input: 100, output: 0 } },
  ];
  const series = analytics.buildModelSeries(rows, { endDay: "2024-01-14", weeks: 4, weekStartsOn: 0 });
  assert.equal(series.weeks.length, 4);
  assert.equal(series.maxTotal, 400);

  const card = instance.modelChartCard(c, series);
  const chart = card.childNodes[1];
  const barsRow = chart.childNodes[0].childNodes[1];
  assert.equal(barsRow.childNodes.length, 4, "one column per week");
  const tallest = barsRow.childNodes[2];
  assert.equal(tallest.childNodes.length, 1, "active week has a stacked column");
  assert.equal(tallest.childNodes[0].childNodes.length, 2, "two models stack in one week");
  const legend = chart.childNodes[2];
  assert.equal(legend.childNodes.length, series.models.length, "one legend entry per model");
});

test("stat grids top-align rows when optional notes change sibling heights", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const totals = {
    total: 1200, input: 800, output: 300, reasoning: 100, cacheRead: 100, cacheWrite: 0,
    sessions: 2, messages: 3, longestTaskMs: 4000,
  };
  const heatmap = buildHeatmap([], { endDay: "2024-01-20", weeks: 3, weekStartsOn: 0 });
  const detail = instance.tokenDetailCard(c, heatmap, "2024-01-10", "2024-01-20", totals, {
    name: "model-a",
    sublabel: "provider-a",
  }, totals, { name: "model-b", sublabel: "provider-b" });
  const snapshot = savedSnapshot();
  const status = instance.statusCard(c, snapshot, snapshot.config);
  const allTimeColumn = detail.childNodes[0].childNodes[0];
  const todayColumn = detail.childNodes[0].childNodes[1];
  const statRows = [
    allTimeColumn.childNodes[1],
    todayColumn.childNodes[1],
    status.childNodes[1],
  ];

  for (const row of statRows) {
    assert.equal(row.style.alignItems, "start");
  }
  assert.deepEqual(
    allTimeColumn.childNodes[1].childNodes.map((cell) => cell.childNodes[0].childNodes[0]),
    ["INPUT", "OUTPUT", "CACHE HIT RATE", "TOP MODEL"],
    "the detail card keeps only input, output, hit rate and top model",
  );
  assert.deepEqual(allTimeColumn.childNodes[0].childNodes, ["ALL TIME"]);

  const noted = statRows[0].childNodes.filter((cell) => cell.childNodes.length === 3);
  assert.equal(noted.length, 0, "the detail card shows values only, no notes");
  assert.equal(statRows[1].childNodes.every((cell) => cell.childNodes.length === 2), true);
  assert.equal(statRows[2].childNodes.every((cell) => cell.childNodes.length === 2), true);
});

test("cache hit rate is a share of input-side tokens", () => {
  assert.equal(analytics.formatHitRate(100, 900), "90%");
  assert.equal(analytics.formatHitRate(0, 0), "—");
  assert.equal(analytics.formatHitRate(200, 0), "0%");
});

test("initial async snapshot publishes the dashboard before settings host controls exist", async () => {
  globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node: "/test/node" }) });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  const notifications = [];
  const notify = cx.notify.bind(cx);
  cx.notify = () => {
    notifications.push({ dashboard: instance.dashboard?.period ?? null, loading: instance.loading });
    notify();
  };
  instance.init({}, cx);

  assert.equal(instance.refreshInput, null);
  assert.equal(instance.configEditor, null);
  assert.equal(instance.sourceInputs.size, 0);

  await flush();
  await flush();
  await flush();

  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.snapshot?.rowCount, 0);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.dashboardKey !== null, true);
  assert.equal(instance.refreshInput, null, "dashboard refresh must not create the refresh input");
  assert.equal(instance.configEditor, null, "dashboard refresh must not create the JSON editor");
  assert.equal(instance.sourceInputs.size, 0, "dashboard refresh must not create source inputs");
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 0, editorStates: 0 });
  assert.equal(calls.notify > 0, true);
  assert.deepEqual(notifications.at(-1), { dashboard: "all", loading: false });

  instance.openSettings(cx);
  assert.equal(instance.refreshInput !== null, true);
  assert.equal(instance.configEditor !== null, true);
  assert.equal(instance.sourceInputs.size, 1);
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 2, editorStates: 1 });
  assert.match(instance.configEditor.value(), /"refreshSeconds": 60/);
  instance.close();
});

test("form saves preserve the legacy profile and multi-root source mappings", () => {
  const instance = blankInstance();
  const saved = savedSnapshot();
  const profile = { name: "Legacy Name", handle: "legacy", avatar: "mods/insights/legacy.png" };
  const mapping = { session: "session.id", timestamp: "ts", usage: { input: "usage.input" } };
  saved.config.profile = profile;
  saved.config.sources = [{
    id: "codex",
    label: "Codex",
    adapter: "codex",
    enabled: true,
    roots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    mapping,
  }];
  Object.assign(instance, {
    snapshot: saved,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: true,
    configDraft: JSON.parse(JSON.stringify(saved.config)),
    sourceInputs: new Map(),
    syncingInputs: false,
    refreshInput: { value: () => "120" },
    configEditor: { value: () => JSON.stringify(saved.config), set_value() {}, on() {} },
  });
  instance.ensureSourceInputs(instance.configDraft);
  const state = instance.sourceInputs.get("codex");
  assert.equal(state.value(), "~/.codex/sessions, ~/.codex/archived_sessions");
  const config = instance.buildConfigForSave();
  assert.deepEqual(config.profile, profile);
  assert.deepEqual(config.sources[0].roots, ["~/.codex/sessions", "~/.codex/archived_sessions"]);
  assert.deepEqual(config.sources[0].mapping, mapping);
  assert.equal(config.refreshSeconds, 120);
});

test("background snapshots leave closed settings drafts and host inputs untouched", async () => {
  const draft = configDraft();
  const customState = {
    value: "~/custom",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    on() {},
  };
  const instance = blankInstance();
  Object.assign(instance, {
    showSettings: false,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: draft,
    sourceInputs: new Map([["custom", customState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "120" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), fakeCx());
  assert.equal(instance.sourceInputs.has("custom"), true);
  assert.equal(instance.sourceInputs.has("saved"), false);
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.equal(customState.writes, 0);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.deepEqual(instance.configDraft.sources[0].extra, { keep: true });
  assert.deepEqual(instance.configDraft.customTopLevel, { keep: true });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.refreshInput.writes, 0);
  assert.equal(instance.configEditor.writes, 0);
  assert.equal(instance.scheduleCalls, 1);

  const editorInstance = blankInstance();
  const savedState = {
    value: "~/saved",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    release() { this.released = true; },
    on() {},
  };
  Object.assign(editorInstance, {
    showSettings: false,
    configDirty: false,
    editorDirty: true,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: JSON.parse(JSON.stringify(savedSnapshot().config)),
    sourceInputs: new Map([["saved", savedState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "60" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  editorInstance.applySnapshot(presentationFor(savedSnapshot(), editorInstance.dashboardOptions()), fakeCx());
  assert.equal(editorInstance.sourceInputs.has("saved"), true);
  assert.equal(savedState.released, false);
  assert.equal(savedState.writes, 0);
  assert.equal(editorInstance.configEditor.value(), JSON.stringify(draft));
  assert.equal(editorInstance.editorTextWrites ?? 0, 0);

  // Reopening Settings after a closed background refresh must reuse the dirty draft.
  instance.showSettings = true;
  const { cx } = liveCx();
  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), cx);
  await flush();
  await flush();
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.configEditor.writes, 0);
});

test("async presentation refresh clears busy state and exposes a finite error", async () => {
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: () => ({ code: 1, stdout: "", stderr: "scan failed" }),
  });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.loading, false);
  assert.equal(instance.busy(), false);
  assert.match(instance.error, /scan failed/);
  assert.equal(instance.snapshot, null);
  instance.close();
});

test("filter changes coalesce while a presentation prepare is in flight", async () => {
  const { todayKey } = analytics;
  const today = todayKey();
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${today}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  snapshot.rows = [{
    day: today,
    session: "session-a",
    harness: "saved",
    provider: "provider",
    model: "model",
    project: "/tmp/project",
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 120 },
    messages: 1,
    activeMs: 1000,
    longestTaskMs: 1000,
  }];
  const pending = [];
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare") {
        return new Promise((resolve) => {
          pending.push({ options: optionArgument(args), resolve });
        });
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.loading, false);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "week");
  assert.equal(instance.dashboardPending !== null, true);

  instance.setPeriod("month", cx);
  assert.equal(instance.dashboardQueued, true);
  const first = pending.shift();
  first.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, first.options, "prepare")), stderr: "" });
  await flush();
  await flush();
  assert.equal(instance.dashboard?.period, "all", "a stale prepare must never replace the current filter result");
  assert.equal(calls.after.filter((timer) => !timer.cancelled).length, 1, "the latest filter is prepared next");

  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "month");
  const latest = pending.shift();
  latest.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, latest.options, "prepare")), stderr: "" });
  await flush();
  await flush();

  assert.equal(instance.dashboard?.period, "month");
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardQueued, false);
  assert.equal(instance.dashboardError, null);
  instance.close();
});

test("a failed prepare leaves the old dashboard and a retryable error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let failPrepare = true;
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && failPrepare) {
        return { code: 1, stdout: "", stderr: "prepare failed" };
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  await flush();
  await flush();
  assert.match(instance.dashboardError, /prepare failed/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboard?.period, "all");

  failPrepare = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  assert.equal(instance.dashboardPending, null);
  instance.close();
});

test("partial scan continuation reschedules while busy and stops on close", async () => {
  const { cx, calls } = liveCx();
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refreshInput = null;
  instance.configEditor = null;
  const refreshes = [];
  instance.refresh = (timerCx) => refreshes.push(timerCx);
  instance.snapshot = { ...savedSnapshot(), scan: { status: "partial", processed: 1, total: 3 } };

  instance.saving = true;
  instance.scheduleScanContinue(cx);
  assert.equal(calls.after.length, 1);
  await calls.runAfter();
  assert.equal(refreshes.length, 0, "a busy tick must not drop the continuation");
  assert.equal(calls.after.filter((timer) => !timer.cancelled).length, 1, "the timer reschedules");

  instance.saving = false;
  instance.loading = false;
  await calls.runAfter();
  assert.equal(refreshes.length, 1, "the continuation runs once the save finishes");

  instance.snapshot.scan = { status: "partial", processed: 2, total: 3 };
  instance.scheduleScanContinue(cx);
  const pending = calls.after.filter((timer) => !timer.cancelled);
  assert.equal(pending.length, 1);
  instance.close();
  assert.equal(pending[0].cancelled, true, "close cancels the pending continuation");
  await calls.runAfter();
  assert.equal(refreshes.length, 1, "a closed view never refreshes again");
});

test("a hung prepare times out into a retryable dashboard error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let hang = true;
  useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && hang) return new Promise(() => {});
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(instance.dashboardPending !== null, true);
  assert.equal(instance.dashboardTask !== null, true);

  await calls.runAfter();
  await flush();
  assert.match(instance.dashboardError, /timed out/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboardQueued, false);

  hang = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  instance.close();
});

for (const kind of ["refresh", "save"]) {
  test(`late ${kind} completion cannot overwrite a retry or clear its busy state`, async () => {
    const pending = [];
    useHerdr({ execResult: (_command, args) => new Promise((resolve) => {
      pending.push({ resolve, options: optionArgument(args) });
    }) });
    const { cx, calls } = liveCx();
    const instance = blankInstance();
    instance.buildConfigForSave = () => savedSnapshot().config;
    const start = () => kind === "refresh" ? instance.refresh(cx) : instance.saveConfig(cx);
    start();
    await flush();
    assert.equal(pending.length, 1);
    const watchdog = calls.after.find((timer) => timer.ms === 35_000 && !timer.cancelled);
    watchdog.fn();
    assert.equal(instance.busy(), false);
    start();
    await flush();
    assert.equal(pending.length, 2);
    const first = pending[0];
    first.resolve({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), first.options)), stderr: "" });
    await flush();
    assert.equal(instance.busy(), true, "stale finally must not clear retry flags");
    assert.equal(instance.snapshot, null, "stale data must not publish");
    const second = pending[1];
    second.resolve({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), second.options)), stderr: "" });
    await flush();
    assert.equal(instance.busy(), false);
    assert.ok(instance.snapshot);
  });
}

for (const editKind of ["toggle", "editor", "invalid editor", "roots", "refresh interval"]) {
  test(`newer ${editKind} edits survive an in-flight configuration save`, async () => {
    let finish;
    let options;
    useHerdr({ execResult: (_command, args) => {
      options = optionArgument(args);
      return new Promise((resolve) => { finish = resolve; });
    } });
    const { cx } = liveCx();
    const instance = blankInstance();
    instance.sourceInputs = new Map();
    instance.configDraft = structuredClone(savedSnapshot().config);
    instance.configText = JSON.stringify(instance.configDraft);
    instance.configEditor = globalThis.__insightsTestEditorState.new({ value: instance.configText });
    instance.ensureSourceInputs(instance.configDraft);
    instance.configDirty = true;
    instance.saveConfig(cx);
    await flush();
    if (editKind === "toggle") instance.updateDraft((draft) => { draft.palette = "green"; });
    else if (editKind.includes("editor")) {
      instance.configEditor.set_value(editKind === "invalid editor" ? "{unfinished" : JSON.stringify({ ...instance.configDraft, palette: "purple" }));
      instance.editorDirty = true;
      instance.configDirty = true;
    } else if (editKind === "roots") {
      instance.sourceInputs.values().next().value.set_value("/new/root");
      instance.rootsDirty = true;
    } else {
      instance.refreshInput = globalThis.__insightsTestInputState.new({ value: "300" });
      instance.refreshDirty = true;
    }
    const newer = instance.draftSignature();
    finish({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), options, "configure")), stderr: "" });
    await flush();
    assert.equal(instance.configDirty, true);
    assert.equal(instance.draftSignature(), newer);
    assert.match(instance.saveMessage, /Newer edits are still unsaved/);
    instance.close();
  });
}

test("Retry resolves a repaired runtime configuration without reopening the view", async () => {
  let reads = 0;
  const state = useHerdr({ readTextFile: () => ++reads === 1 ? "{invalid" : JSON.stringify({ node: "/test/node" }) });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);
  await flush();
  assert.ok(instance.runtimeError);
  assert.equal(state.execCalls.length, 0);
  instance.refresh(cx);
  await flush();
  await flush();
  assert.equal(reads, 2);
  assert.equal(instance.runtimeError, null);
  assert.ok(instance.snapshot);
  instance.close();
});

test("closing a view invalidates a refresh even if its host exec resolves late", async () => {
  let finish;
  let options;
  useHerdr({ execResult: (_command, args) => {
    options = optionArgument(args);
    return new Promise((resolve) => { finish = resolve; });
  } });
  const { cx, calls } = liveCx();
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refresh(cx);
  await flush();
  instance.close();
  const notified = calls.notify;
  finish({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), options)), stderr: "" });
  await flush();
  assert.equal(instance.snapshot, null);
  assert.equal(calls.notify, notified);
});

test("malformed compact dashboards become a retryable error, never render state", async () => {
  useHerdr({ execResult: (_command, args) => {
    const payload = presentationFor(savedSnapshot(), optionArgument(args));
    payload.dashboard = {};
    return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
  } });
  const { cx } = liveCx();
  const instance = blankInstance();
  instance.refresh(cx);
  await flush();
  assert.equal(instance.snapshot, null);
  assert.equal(instance.busy(), false);
  assert.match(instance.error, /unexpected|invalid/i);
});

test("scan progress awaits the host read and ignores results after cancellation", async () => {
  let resolveRead;
  useHerdr({ readTextFile: () => new Promise((resolve) => { resolveRead = resolve; }) });
  const instance = blankInstance();
  instance.loading = true;
  const { cx, calls } = liveCx();
  instance.armProgress(cx);
  calls.timers[0].fn(cx);
  await flush();
  resolveRead(JSON.stringify({ processed: 3, total: 10, file: "/session.jsonl" }));
  await flush();
  assert.equal(instance.scanProgress.processed, 3);
  calls.timers[0].fn(cx);
  await flush();
  instance.cancelProgress();
  resolveRead(JSON.stringify({ processed: 4, total: 10, file: "/old.jsonl" }));
  await flush();
  assert.equal(instance.scanProgress, null);
  assert.equal(instance.progressTask, null);
});

test("progress poll merges mid-file stream state, keeps counts, and stops when settled", async () => {
  const state = useHerdr({
    readTextFile: async () => JSON.stringify({
      file: "/tmp/open-giant.jsonl.zst",
      decodedBytes: 4096,
      rows: [{ injected: true }],
      config: { injected: true },
    }),
  });
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.loading = true;
  const { cx, calls } = liveCx();
  instance.armProgress(cx);
  instance.scanProgress = { processed: 7, total: 11, file: "/tmp/previous.jsonl" };
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(instance.scanProgress.processed, 7, "stream progress keeps accepted counts");
  assert.equal(instance.scanProgress.total, 11);
  assert.equal(instance.scanProgress.decodedBytes, 4096);
  assert.equal(instance.scanProgress.file, "/tmp/open-giant.jsonl.zst");
  assert.equal(instance.scanProgress.rows, undefined, "only display metadata is accepted");
  assert.equal(instance.scanProgress.config, undefined);

  instance.loading = false;
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(instance.scanProgress, null, "completion stops and clears the poll");
  assert.equal(instance.progressTimer, null);
  const reads = state.runtimeReads.length;
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(state.runtimeReads.length, reads, "a settled poll never reads again");

  instance.loading = true;
  instance.armProgress(cx);
  instance.close();
  assert.equal(instance.scanProgress, null, "close cancels in-flight progress");
  assert.equal(instance.progressTimer, null);
});

test("running worker status shows current file and decoded bytes", () => {
  const instance = blankInstance();
  const label = instance.scanStatusLabel({
    status: "running",
    processed: 2,
    total: 10,
    live: {
      file: "/home/u/.codex/sessions/open-giant.jsonl.zst",
      processed: 3,
      total: 10,
      decodedBytes: 123_456,
      phase: "decompress",
    },
  });
  assert.match(label, /Indexing 3 of 10 files/);
  assert.match(label, /open-giant\.jsonl\.zst/, "the live file is visible");
  assert.match(label, /decoded/, "in-progress decoded bytes are visible");
});
