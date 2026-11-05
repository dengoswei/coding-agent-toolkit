import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  APP_FILES,
  PACKAGE_ROOT,
  SINGLE_TOOLBAR_CONTENT,
  TOOLBAR_LAYOUT,
  assertFailure,
  assertStagedChecks,
  assertSuccess,
  createFakeRunner,
  createSource,
  exists,
  hash,
  makeEnvironment,
  readJson,
  readLog,
  runInstall,
  runUninstall,
  snapshotTree,
  temporaryRoot,
  writeTree,
} from "./install-fixtures.mjs";

function toolbarButton(layout) {
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node?.children ?? []) walk(child);
  };
  walk(layout);
  return nodes.find((node) => node.id === "insights-toolbar-button");
}

test("integration opt-in compacts only an unchanged owned legacy toolbar and preserves other settings", async (t) => {
  const root = await temporaryRoot(t), sourceRoot = await createSource(root), appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES); const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const file = path.join(appHome, "layouts/main-insights.json");
  const layout = await readJson(file); toolbarButton(layout).size.px = 224;
  const text = `${JSON.stringify(layout, null, 2)}\n`; await fs.writeFile(file, text);
  const recordFile = path.join(appHome, "data/insights/toolbar-install.json");
  const record = await readJson(recordFile); record.hash = hash(text); await fs.writeFile(recordFile, JSON.stringify(record));
  assertSuccess(runInstall({ appHome, fake, sourceRoot, extra: ["--integrations"] }));
  assert.equal(toolbarButton(await readJson(file)).size.px, 104);
  assert.equal((await readJson(path.join(appHome, "data/insights/integrations.json"))).enabled, true);
  assert.equal((await readJson(recordFile)).hash, hash(await fs.readFile(file, "utf8")));
  assert.equal(await fs.readFile(path.join(appHome, "keys.json"), "utf8"), APP_FILES["keys.json"]);
  assert.equal(await fs.readFile(path.join(appHome, "data/insights/insights.json"), "utf8"), APP_FILES["data/insights/insights.json"]);
});


test("standalone distribution installs one mod and a single-mod toolbar without a launcher", async (t) => {
  const root = await temporaryRoot(t);
  const distribution = path.join(root, "herdr-insights");
  await fs.cp(PACKAGE_ROOT, distribution, { recursive: true });
  const appHome = path.join(root, "app");
  await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
  const fake = await createFakeRunner(root);
  const result = spawnSync(process.execPath, [path.join(distribution, "scripts/install.mjs")], {
    cwd: distribution,
    env: makeEnvironment(root, appHome, fake),
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  assertSuccess(result);
  assert.match(result.stdout, /herdr-app check passed/);
  const log = await readLog(fake);
  const checks = await assertStagedChecks(log, ["insights"], appHome);
  assert.deepEqual(log.map((entry) => entry.args), [
    ["status"],
    ...checks,
    ["do", "layout.clone", '{"name":"main","as":"main-insights"}'],
  ]);
  assert.deepEqual((await fs.readdir(path.join(appHome, "mods"))).sort(), ["insights"]);
  await assert.rejects(fs.lstat(path.join(appHome, "data/insights/launcher-install-manifest.json")), { code: "ENOENT" });
  const layout = await readJson(path.join(appHome, "layouts/main-insights.json"));
  assert.deepEqual(toolbarButton(layout).content, SINGLE_TOOLBAR_CONTENT);
  const record = await readJson(path.join(appHome, "data/insights/toolbar-install.json"));
  const text = await fs.readFile(path.join(appHome, "layouts/main-insights.json"), "utf8");
  assert.equal(record.hash, hash(text));
  assert.equal(log.filter((entry) => entry.args[1] === "mod.open").length, 0, "no floating window");
});

test("one mod reinstalls idempotently and uninstall preserves data and local edits", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  let log = await readLog(fake);
  await assertStagedChecks(log, ["insights"], appHome);
  const manifest = await readJson(path.join(appHome, "data/insights/install-manifest.json"));
  assert.equal(manifest.target, "mods/insights");
  assert.deepEqual(toolbarButton(await readJson(path.join(appHome, "layouts/main-insights.json"))).content,
    SINGLE_TOOLBAR_CONTENT);

  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[1] === "layout.clone").length, 1,
    "reinstall must not clone another layout");
  assert.equal(log.filter((entry) => entry.args[1] === "mod.open").length, 0,
    "no floating window");
  for (const [relative, content] of Object.entries(APP_FILES)) {
    assert.equal(await fs.readFile(path.join(appHome, relative), "utf8"), content);
  }

  const targetMain = path.join(appHome, "mods/insights/main.js");
  await fs.writeFile(targetMain, "local dashboard edit\n");
  await fs.writeFile(path.join(sourceRoot, "mods/insights/main.js"), "new dashboard\n");
  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /Owned file was edited locally/);
  assert.equal(await fs.readFile(targetMain, "utf8"), "local dashboard edit\n");

  assertSuccess(runUninstall({ appHome, fake }));
  assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
  assert.equal(await exists(path.join(appHome, "data/insights/toolbar-install.json")), false);
  assert.equal(await fs.readFile(targetMain, "utf8"), "local dashboard edit\n");
  assert.equal(await exists(path.join(appHome, "mods/insights/mod.json")), false);
  assert.equal(await fs.readFile(path.join(appHome, "data/insights/insights.json"), "utf8"),
    APP_FILES["data/insights/insights.json"]);
});

test("mod collisions and links fail before the mod or toolbar is written, even with --force", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const fake = await createFakeRunner(root);
  for (const kind of ["unowned", "symlink"]) {
    const appHome = path.join(root, kind);
    const target = path.join(appHome, "mods/insights");
    if (kind === "unowned") await writeTree(target, { "main.js": "unowned\n" });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(sourceRoot, "mods/insights"), target);
    }
    const refused = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
    assertFailure(refused);
    assert.match(refused.stderr, /unowned collision|symbolic-link target/);
    assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
  }
  assert.deepEqual(await readLog(fake), []);
});

test("a native check failure never clones a layout or opens a dashboard tab", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const fake = await createFakeRunner(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
  const result = runInstall({ appHome, fake, sourceRoot, fail: "check" });
  assertFailure(result);
  const log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[0] === "check").length, 1);
  assert.equal(log.filter((entry) => entry.args[0] === "do").length, 0);
  assert.equal(log.filter((entry) => entry.args[1] === "tab.new").length, 0);
  assert.equal(await exists(path.join(appHome, "mods/insights")), false);
});

test("toolbar refuses unsupported layouts and state symlinks before writing the mod", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const fake = await createFakeRunner(root);
  for (const kind of ["unsupported", "symlink", "state-link", "state-directory-link"]) {
    const appHome = path.join(root, kind);
    await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
    if (kind === "state-link") {
      await fs.mkdir(path.join(appHome, "layouts/.state"));
      await fs.symlink(path.join(sourceRoot, "layouts/other.json"), path.join(appHome, "layouts/.state/main.json"));
    }
    if (kind === "state-directory-link") {
      await fs.symlink(path.join(sourceRoot, "layouts"), path.join(appHome, "layouts/.state"));
    }
    if (kind === "unsupported") await fs.writeFile(path.join(appHome, "layouts/main.json"), '{"id":"root","type":"row","children":[]}');
    if (kind === "symlink") {
      await fs.unlink(path.join(appHome, "layouts/main.json"));
      await fs.symlink(path.join(sourceRoot, "layouts/other.json"), path.join(appHome, "layouts/main.json"));
    }
    const refused = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
    assertFailure(refused);
    assert.match(refused.stderr, /cannot be integrated safely|symbolic link/);
    assert.equal(await exists(path.join(appHome, "mods/insights")), false);
    assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
  }
});

test("reinstall preserves edited personal layouts and uninstall fails closed before deleting anything", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const layoutFile = path.join(appHome, "layouts/main-insights.json");
  const original = await fs.readFile(layoutFile, "utf8");
  const edited = JSON.parse(original);
  edited.ui_font = "My custom font";
  const custom = JSON.stringify(edited, null, 2) + "\n";
  await fs.writeFile(layoutFile, custom);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal(await fs.readFile(layoutFile, "utf8"), custom);
  const before = await snapshotTree(appHome);
  const refused = runUninstall({ appHome, fake });
  assertFailure(refused);
  assert.match(refused.stderr, /Toolbar layout was edited locally/);
  assert.deepEqual(await snapshotTree(appHome), before);
  await fs.writeFile(layoutFile, original);
  assertSuccess(runUninstall({ appHome, fake }));
  const log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[1] === "layout.clone").length, 1);
  assert.deepEqual(log.at(-2).args, ["do", "layout.switch", '{"name":"main"}']);
  assert.deepEqual(log.at(-1).args, ["status"]);
  assert.equal(await fs.readFile(path.join(appHome, "layouts/main.json"), "utf8"), TOOLBAR_LAYOUT);
});

test("toolbar skips layout/state collisions, preserves click state, and can reinstall after uninstall", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app");
  const state = '{"nodes":{"panel":{"hidden":false}},"theme":"ink"}\n';
  await writeTree(appHome, {
    ...APP_FILES,
    "layouts/.state/main.json": state,
    "layouts/main-insights.json": "unowned layout\n",
    "layouts/.state/main-insights-2.json": "unowned click state\n",
  });
  const outside = path.join(root, "outside-state.json");
  await fs.writeFile(outside, "outside state\n");
  await fs.symlink(outside, path.join(appHome, "layouts/.state/main-insights-3.json"));
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const recordFile = path.join(appHome, "data/insights/toolbar-install.json");
  assert.equal((await readJson(recordFile)).layout, "main-insights-4");
  const stateFile = path.join(appHome, "layouts/.state/main-insights-4.json");
  assert.equal(await fs.readFile(stateFile, "utf8"), state);
  await fs.writeFile(stateFile, "user's updated click state\n");
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal(await fs.readFile(stateFile, "utf8"), "user's updated click state\n");
  assertSuccess(runUninstall({ appHome, fake }));
  assert.equal(await fs.readFile(stateFile, "utf8"), "user's updated click state\n");
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal((await readJson(recordFile)).layout, "main-insights-5");
  assert.equal(await fs.readFile(path.join(appHome, "layouts/main-insights.json"), "utf8"), "unowned layout\n");
  assert.equal(await fs.readFile(path.join(appHome, "layouts/.state/main-insights-2.json"), "utf8"), "unowned click state\n");
  assert.equal(await fs.readFile(outside, "utf8"), "outside state\n");
});

test("uninstall verifies the original layout exists and actually became selected", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  for (const fail of ["missing-source", "ignored-switch"]) {
    const appHome = path.join(root, fail);
    await writeTree(appHome, APP_FILES);
    const fake = await createFakeRunner(path.join(root, `${fail}-runner`));
    assertSuccess(runInstall({ appHome, fake, sourceRoot }));
    if (fail === "missing-source") await fs.unlink(path.join(appHome, "layouts/main.json"));
    const refused = runUninstall({ appHome, fake, fail });
    assertFailure(refused);
    assert.match(refused.stderr, /Original layout main is missing|Herdr did not leave/);
    assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), true);
    assert.equal(await exists(path.join(appHome, "mods/insights/main.js")), true);
    assert.equal(await exists(path.join(appHome, "data/insights/toolbar-install.json")), true);
  }
});

test("toolbar ownership records reject traversal and do not overwrite personal files", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const fake = await createFakeRunner(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, {
    ...APP_FILES,
    "data/insights/toolbar-install.json": JSON.stringify({ version: 1, owner: "herdr-insights-toolbar",
      source: "../escape", layout: "../escape-insights", hash: "a".repeat(64) }),
  });
  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /Invalid toolbar ownership record/);
  assert.equal(await exists(path.join(appHome, "mods/insights")), false);
  assert.deepEqual(await readLog(fake), []);
  assertFailure(runUninstall({ appHome, fake }));
});
