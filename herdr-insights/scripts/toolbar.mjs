import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertNoSymlinkComponents, dataDir, ensureDirectory, HASH_RE, herdrFailure,
  lstatOrNull, runHerdr, sha256, writeFileAtomic,
} from "./lib.mjs";

const RECORD = "toolbar-install.json";
const OWNER = "herdr-insights-toolbar";
const BUTTON_ID = "insights-toolbar-button";
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function assertName(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`Unsupported layout name: ${JSON.stringify(name)}`);
}

function layoutFile(appHome, name) {
  assertName(name);
  return path.join(appHome, "layouts", `${name}.json`);
}

function stateFile(appHome, name) {
  assertName(name);
  return path.join(appHome, "layouts", ".state", `${name}.json`);
}

async function readRegular(appHome, file) {
  await assertNoSymlinkComponents(appHome, file);
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  return fs.readFile(file, "utf8");
}

async function readRecord(appHome) {
  const file = path.join(dataDir(appHome), RECORD);
  const text = await readRegular(appHome, file);
  if (text === null) return null;
  const record = JSON.parse(text);
  if (record?.version !== 1 || record.owner !== OWNER ||
      typeof record.source !== "string" || !NAME.test(record.source) ||
      typeof record.layout !== "string" || !NAME.test(record.layout) ||
      !record.layout.startsWith(`${record.source}-insights`) ||
      typeof record.hash !== "string" || !HASH_RE.test(record.hash)) {
    throw new Error(`Invalid toolbar ownership record: ${file}`);
  }
  return record;
}

async function command(appHome, args) {
  const result = await runHerdr(args, { env: { HERDR_APP_HOME: appHome } });
  if (result.error || result.code !== 0 || result.signal) {
    throw new Error(herdrFailure(result, `herdr-app ${args.slice(0, 2).join(" ")}`));
  }
  return result.stdout;
}

/** Preserve the original tabs mod and its updates; compose one native button beside it. */
export function withInsightsToolbar(layout) {
  const copy = structuredClone(layout);
  const nodes = [];
  function walk(node) {
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(copy);
  if (nodes.some((node) => node.id === BUTTON_ID || node.id === "insights-original-tabs")) {
    throw new Error("This layout already contains Insights toolbar blocks.");
  }
  const matches = nodes.filter((node) => node.id === "tabs" && node.type === "block" && node.content?.mod === "tabs");
  if (matches.length !== 1) {
    throw new Error('Expected one native "tabs" block. This layout cannot be integrated safely.');
  }
  const tabs = matches[0];
  const content = tabs.content;
  delete tabs.content;
  tabs.type = "row";
  tabs.resizable = false;
  tabs.children = [
    { id: "insights-original-tabs", type: "block", size: { weight: 1 }, content },
    { id: BUTTON_ID, type: "block", size: { px: 104 }, content: { mod: "insights", props: { mode: "toolbar" } } },
  ];
  return copy;
}

export async function prepareToolbar(appHome) {
  const record = await readRecord(appHome);
  if (record) {
    const file = layoutFile(appHome, record.layout);
    if (await readRegular(appHome, file) === null) throw new Error(`Owned toolbar layout is missing: ${file}`);
    // Reinstall never rewrites a personal layout or changes the chosen layout.
    return { appHome, record };
  }
  const status = JSON.parse(await command(appHome, ["status"]));
  const source = status.layout;
  const sourceFile = layoutFile(appHome, source);
  const original = await readRegular(appHome, sourceFile);
  if (original === null) throw new Error(`Layout not found: ${sourceFile}`);
  withInsightsToolbar(JSON.parse(original)); // Validate before cloning or writing mods.
  // Native cloning also copies click state. Never let it follow a state link,
  // overwrite another layout's state, or destroy state left from an uninstall.
  await readRegular(appHome, stateFile(appHome, source));
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const layout = `${source}-insights${suffix === 1 ? "" : `-${suffix}`}`;
    const file = layoutFile(appHome, layout);
    const state = stateFile(appHome, layout);
    await assertNoSymlinkComponents(appHome, path.dirname(state));
    if (await lstatOrNull(file) || await lstatOrNull(state)) continue;
    return { appHome, source, layout, file };
  }
  throw new Error("No free Insights layout name; existing layouts and click state were preserved.");
}

export async function applyToolbar(plan, { expand = false } = {}) {
  if (plan.record) {
    if (!expand) return;
    const file = layoutFile(plan.appHome, plan.record.layout);
    const original = await readRegular(plan.appHome, file);
    if (sha256(original) !== plan.record.hash) throw new Error("Toolbar layout was edited locally; preserve it before updating Scream.");
    const layout = JSON.parse(original);
    const walk = (node) => {
      if (node.id === BUTTON_ID && node.size?.px === 224) node.size.px = 104;
      for (const child of node.children ?? []) walk(child);
    };
    walk(layout);
    const updated = `${JSON.stringify(layout, null, 2)}\n`;
    if (updated !== original) {
      await writeFileAtomic(file, updated);
      await writeFileAtomic(path.join(dataDir(plan.appHome), RECORD), `${JSON.stringify({ ...plan.record, hash: sha256(updated) }, null, 2)}\n`);
    }
    return;
  }
  const { appHome, source, layout, file } = plan;
  // Checks may have taken seconds. Revalidate clone inputs immediately before
  // Herdr can copy state (its native clone may overwrite destination state).
  await readRegular(appHome, stateFile(appHome, source));
  const state = stateFile(appHome, layout);
  await assertNoSymlinkComponents(appHome, state);
  await assertNoSymlinkComponents(appHome, file);
  if (await lstatOrNull(file) || await lstatOrNull(state)) {
    throw new Error(`Toolbar destination appeared during install: ${layout}; no layout or click state replaced.`);
  }
  await command(appHome, ["do", "layout.clone", JSON.stringify({ name: source, as: layout })]);
  try {
    // The supported clone command preserves Herdr's click/appearance state.
    const cloned = await readRegular(appHome, file);
    if (cloned === null) throw new Error(`Herdr did not create ${file}`);
    const text = `${JSON.stringify(withInsightsToolbar(JSON.parse(cloned)), null, 2)}\n`;
    await writeFileAtomic(file, text);
    await ensureDirectory(appHome, dataDir(appHome), "Insights data directory");
    await writeFileAtomic(path.join(dataDir(appHome), RECORD), `${JSON.stringify({
      version: 1, owner: OWNER, source, layout, hash: sha256(text),
    }, null, 2)}\n`);
  } catch (error) {
    // Do not leave a failed integration selected; keep the clone for inspection.
    try { await command(appHome, ["do", "layout.switch", JSON.stringify({ name: source })]); } catch { /* retain original failure */ }
    throw error;
  }
  console.log(`Added Insights beside Files/Changes in personal layout ${layout}; Herdr's tabs mod is unchanged.`);
}

const SCREAM_CONTROL_V1 = `.child(div().id("insights-scream-chicken").w(32).h(26).flex_none().flex().items_center().justify_center().rounded(6)
        .hover(s => s.bg(t.hover)).active(s => s.bg(t.selected)).tooltip("尖叫")
        .on_mouse_down("left", stop).on_click((_e, cx) => insightsScream(cx))
        .child(image("mods/insights/scream-chicken.svg").id("scream-chicken-image").w(22).h(22).active(s => s.w(16))))
      `;

const SCREAM_CONTROL_V2 = `.child(div().id("insights-scream-chicken").w(34).h(30).flex_none().flex().items_center().justify_center().cursor_pointer().tooltip("尖叫")
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.screamPressed = true; cx.notify(); })
        .on_mouse_up("left", (_e, cx) => { this.screamPressed = false; cx.notify(); })
        .on_hover((hovered, cx) => { if (!hovered && this.screamPressed) { this.screamPressed = false; cx.notify(); } })
        .on_click((_e, cx) => insightsScream(cx))
        .child(div().id("scream-chicken-surface").w(this.screamPressed ? 32 : 30).h(this.screamPressed ? 26 : 30)
          .flex().items_center().justify_center().rounded(8).border(1)
          .border_color(this.screamPressed ? "#ffd54f" : "#00000000")
          .bg(this.screamPressed ? "#704900" : "#00000000")
          .transition("width", 75).transition("height", 75)
          .when(!this.screamPressed, el => el.hover(s => s.bg(t.hover)))
          .child(image(this.screamPressed ? "mods/insights/scream-chicken-pressed.svg" : "mods/insights/scream-chicken.svg")
            .id("scream-chicken-image").w(this.screamPressed ? 25 : 20).h(this.screamPressed ? 20 : 26))))
      `;

/** Replace only our recognized control; retain unrelated personal tab edits. */
export function upgradeScreamControl(source) {
  if (source.includes(SCREAM_CONTROL_V2)) return source;
  if (!source.includes(SCREAM_CONTROL_V1)) throw new Error("Scream control was edited locally; refusing an automatic replacement");
  return source.replace(SCREAM_CONTROL_V1, SCREAM_CONTROL_V2);
}

export function withScreamControl(source) {
  const anchor = '.child(button("tab-new",';
  if (!source.includes(anchor) || !source.includes('image } from "gpui-kit"')) throw new Error("Unsupported native tabs version for Scream placement");
  const helper = `import * as screamHost from "herdr";
function insightsScream(cx) {
  const focus = screamHost.focused();
  const target = { terminal: focus?.terminal, machine: screamHost.spaces().find(s => s.id === focus?.space)?.machine ?? null, at: new Date().toISOString() };
  screamHost.playSound("mods/insights/scream.wav");
  cx.spawn(async (_taskCx) => {
    try {
      if (!target.terminal) throw new Error("Focus an agent terminal first");
      const runtime = JSON.parse(await screamHost.readTextFile(screamHost.appHome() + "/mods/insights/runtime.json"));
      const result = await screamHost.exec(runtime.node, [screamHost.appHome() + "/mods/insights/actions.mjs", "scream", screamHost.appHome() + "/data/insights", JSON.stringify(target)]);
      if (result.code !== 0) throw new Error("Could not save feedback; focus an agent terminal and try again");
    } catch (error) { screamHost.notify({title:"Scream was not recorded", body:String(error.message), level:"error"}); }
  });
}
`;
  return `${helper}\n${source.replace(anchor, `${SCREAM_CONTROL_V2}${anchor}`)}`;
}

export async function installScreamControl(appHome) {
  const record = await readRecord(appHome);
  if (!record) throw new Error("Insights toolbar is not installed");
  const file = layoutFile(appHome, record.layout);
  const original = await readRegular(appHome, file);
  if (sha256(original) !== record.hash) throw new Error("Personal layout changed; refusing to replace its tab controls");
  let mod = record.scream_mod;
  if (!mod) {
    const source = await readRegular(appHome, path.join(appHome, "mods/tabs/main.js"));
    if (source === null) return; // Headless installer fixtures have no shipped UI.
    withScreamControl(source); // Validate before cloning anything.
    for (let suffix = 1; suffix < 100; suffix++) {
      const candidate = `insights-tabs${suffix === 1 ? "" : `-${suffix}`}`;
      if (!await lstatOrNull(path.join(appHome, "mods", candidate))) { mod = candidate; break; }
    }
    if (!mod) throw new Error("No free personal tabs mod name");
    await command(appHome, ["do", "mod.clone", JSON.stringify({ name: "tabs", as: mod })]);
    const main = path.join(appHome, "mods", mod, "main.js");
    const cloned = await readRegular(appHome, main);
    await writeFileAtomic(main, withScreamControl(cloned));
    await command(appHome, ["check", path.dirname(main)]);
  }
  assertName(mod);
  const main = path.join(appHome, "mods", mod, "main.js");
  const previous = await readRegular(appHome, main);
  const upgraded = upgradeScreamControl(previous);
  if (upgraded !== previous) {
    await writeFileAtomic(main, upgraded);
    try { await command(appHome, ["check", path.dirname(main)]); }
    catch (error) {
      if (await readRegular(appHome, main) === upgraded) await writeFileAtomic(main, previous);
      throw error;
    }
  }
  const layout = JSON.parse(original);
  const walk = (node) => {
    if (node.id === "insights-original-tabs") node.content.mod = mod;
    for (const child of node.children ?? []) walk(child);
  };
  walk(layout);
  const updated = `${JSON.stringify(layout, null, 2)}\n`;
  if (updated !== original) await writeFileAtomic(file, updated);
  await writeFileAtomic(path.join(dataDir(appHome), RECORD), `${JSON.stringify({ ...record, hash: sha256(updated), scream_mod: mod, scream_skin: 2 }, null, 2)}\n`);
}

export async function prepareToolbarRemoval(appHome) {
  if (!appHome) return null;
  const record = await readRecord(appHome);
  if (!record) return null;
  const file = layoutFile(appHome, record.layout);
  const text = await readRegular(appHome, file);
  if (text !== null && sha256(text) !== record.hash) {
    throw new Error(`Toolbar layout was edited locally: ${file}. No files removed; preserve/move this layout and its ${RECORD} before uninstalling.`);
  }
  const status = JSON.parse(await command(appHome, ["status"]));
  const active = status.layout === record.layout;
  if (active) {
    const original = await readRegular(appHome, layoutFile(appHome, record.source));
    if (original === null) throw new Error(`Original layout ${record.source} is missing. Select another layout before uninstalling.`);
    JSON.parse(original);
  }
  return { appHome, record, file };
}

export async function removeToolbar(plan) {
  if (!plan) return;
  const { appHome, record, file } = plan;
  let current = await readRegular(appHome, file);
  if (current !== null && sha256(current) !== record.hash) throw new Error(`Toolbar layout changed during uninstall: ${file}`);
  // The person can switch layouts while preflight is running. Never trust its
  // earlier active-layout snapshot when deciding whether it is safe to delete.
  const status = JSON.parse(await command(appHome, ["status"]));
  if (status.layout === record.layout) {
    const original = await readRegular(appHome, layoutFile(appHome, record.source));
    if (original === null) throw new Error(`Original layout ${record.source} is missing. Select another layout before uninstalling.`);
    JSON.parse(original);
    await command(appHome, ["do", "layout.switch", JSON.stringify({ name: record.source })]);
    const afterSwitch = JSON.parse(await command(appHome, ["status"]));
    if (afterSwitch.layout !== record.source) throw new Error(`Herdr did not leave ${record.layout}; no files removed.`);
  }
  // Commands yield to the live app; preserve any edits made during that wait.
  current = await readRegular(appHome, file);
  if (current !== null && sha256(current) !== record.hash) throw new Error(`Toolbar layout changed during uninstall: ${file}`);
  if (current !== null) await fs.unlink(file);
  await fs.unlink(path.join(dataDir(appHome), RECORD));
  console.log(`Removed owned toolbar layout ${record.layout}; original layout ${record.source} is unchanged.`);
}
