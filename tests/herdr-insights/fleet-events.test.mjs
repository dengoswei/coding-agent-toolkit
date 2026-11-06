import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportSnapshot, validateExport, fleetSnapshots, mergeFleet } from "../../herdr-insights/mods/insights/core/fleet.mjs";
import { appendEvent, clearScreams, collectNudges, nudgeEvent, readUserEvents } from "../../herdr-insights/mods/insights/core/events.mjs";
import { parseBillingCache, parseUsageCsv } from "../../herdr-insights/mods/insights/core/cursor.mjs";
import { deriveDashboard, eventStatistics } from "../../herdr-insights/mods/insights/analytics.js";
import { codexFooterModel, resolveSession } from "../../herdr-insights/mods/insights/core/session.mjs";
import { captureScream } from "../../herdr-insights/mods/insights/actions.mjs";
import { cursorSnapshot } from "../../herdr-insights/mods/insights/core/cursor.mjs";
import { DatabaseSync } from "node:sqlite";
import { withScreamControl } from "../../herdr-insights/scripts/toolbar.mjs";

const at = "2026-11-05T12:00:00Z";
const row = { day: "2026-11-05", session: "session1", harness: "codex", provider: "openai", model: "model-a", project: "", tokens: { input: 10, output: 5 }, messages: 1, activeMs: 0, longestTaskMs: 0 };
const snapshot = { version: 1, generatedAt: at, lastCompletedScanAt: at, rows: [row], scan: { status: "complete", processed: 1, total: 1 }, config: { sources: [] } };
async function temporary(t) { const dir = await mkdtemp(path.join(os.tmpdir(), "insights-fleet-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("remote contract allowlists metadata and rejects invalid counters/timezones", () => {
  const remote = exportSnapshot({ ...snapshot, secret: "private", rows: [{ ...row, prompt: "private" }] }, "Asia/Shanghai");
  assert.equal(JSON.stringify(remote).includes("private"), false);
  assert.equal(remote.rows[0].tokens.total, 15);
  assert.throws(() => validateExport(remote, "UTC"));
  assert.throws(() => exportSnapshot({ ...snapshot, rows: [{ ...row, tokens: { input: -1 } }] }, "UTC"));
});

test("dynamic discovery replaces snapshots, follows stable identity across rename, and retains removed hosts", async (t) => {
  const directory = await temporary(t), store = path.join(directory, "insights.json");
  let machines = [{ id: "host-id", name: "devbox", state: "connected", temporary: false }];
  const calls = [];
  const runner = async (_program, args, options) => {
    calls.push({ args, options });
    if (args[0] === "machine") return JSON.stringify({ machines });
    if (args.includes("command -v node")) return "/remote/node\n";
    if (args.includes("-e")) { assert.ok(JSON.parse(options.input).files["remote-export.mjs"]); return JSON.stringify({ node: "/remote/node", bundle: "/remote/bundle" }); }
    return JSON.stringify(exportSnapshot(snapshot, Intl.DateTimeFormat().resolvedOptions().timeZone));
  };
  const first = await fleetSnapshots(store, { refresh: true, runner });
  assert.equal(first.rows.length, 1); assert.equal(first.rows[0].machine, "remote:host-id");
  machines[0].name = "renamed";
  const second = await fleetSnapshots(store, { refresh: true, runner, now: Date.now() + 70000 });
  assert.equal(second.rows.length, 1); assert.equal(second.machines[0].name, "renamed");
  machines = [];
  const offline = await fleetSnapshots(store, { refresh: true, runner, now: Date.now() + 140000 });
  assert.equal(offline.rows.length, 1); assert.equal(offline.machines[0].status, "offline");
  assert.ok(calls.every((call) => Array.isArray(call.args)));
  const merged = mergeFleet(snapshot, first);
  assert.notEqual(merged.rows[0].session, merged.rows[1].session);
});

test("machine selector scopes lifetime, heatmap and model totals; account usage has no invented sessions", () => {
  const fleet = { rows: [{ ...row, machine: "remote:host", session: "remote:session" }], machines: [], events: [], warnings: [] };
  const combined = mergeFleet(snapshot, fleet);
  combined.rows.push({ ...row, machine: "cursor-account", session: "", tokens: { total: 50 } });
  const one = deriveDashboard(combined, { today: row.day, filters: { machine: "local" } });
  assert.equal(one.lifetime.total, 15); assert.equal(one.totals.total, 15);
  assert.equal(one.heatmap.windowTotal, 15);
  const cursor = deriveDashboard(combined, { today: row.day, filters: { machine: "cursor-account" } });
  assert.equal(cursor.lifetime.total, 50); assert.equal(cursor.lifetime.sessions, 0);
  const machines = deriveDashboard(combined, { today: row.day, filters: { machine: "machines" } });
  assert.equal(machines.lifetime.total, 30); assert.equal(machines.lifetime.sessions, 2);
});

test("Cursor billing cache deduplicates overlapping all-spend charts and never counts context occupancy", () => {
  const chart = (tokens, fetchedAt, spendType = "all") => ({ fetchedAt, spendType, response: JSON.stringify({ dailySpend: [{ day: String(Date.parse(at)), category: "model", totalTokens: String(tokens) }] }) });
  const rows = parseBillingCache({ charts: [chart(10, 100), chart(20, 200), chart(99, 300, "included")], contextTokensUsed: 999999 });
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].tokens, { total: 20 });
  const csv = 'Date,Model,Total Tokens\n"2026-11-05T12:00:00Z","model, with comma",42\n';
  assert.equal(parseUsageCsv(csv)[0].tokens.total, 42);
});

test("nudge accounting distinguishes ack, issued, attempted, held and judge models", () => {
  const base = { ts: at, agent: "codex", would_action: "nudge_continue", model: "judge-model" };
  assert.equal(nudgeEvent({ ...base, injected: true }, "shepherd").outcome, "sent");
  assert.equal(nudgeEvent({ ...base, inject_error: "precheck" }, "shepherd").outcome, "attempted");
  assert.equal(nudgeEvent({ ...base, injected: true, dry_run: true }, "shepherd").outcome, "held");
  const hook = nudgeEvent({ ts: at, agent: "pi", action: "continue", result: "continue", continued: true, model: "judge-model", session: "opaque" }, "stop-hook");
  assert.equal(hook.outcome, "issued"); assert.equal(hook.model, "unknown"); assert.notEqual(hook.sessionId, "opaque");
  assert.equal(nudgeEvent({ ts: at, action: "ask_to_structure", counted: true, result: "continue" }, "stop-hook"), null);
});

test("producer pruning, duplicate copies, and incomplete final lines preserve exactly-once retained history", async (t) => {
  const home = await temporary(t), directory = path.join(home, "data");
  const logs = path.join(home, ".local/state/herdr-autopilot"); await mkdir(logs, { recursive: true });
  const file = path.join(logs, "decisions.jsonl");
  const first = JSON.stringify({ ts: at, agent: "codex", would_action: "nudge_continue", injected: true, secret: "not exported" });
  const second = JSON.stringify({ ts: "2026-11-05T12:01:00Z", agent: "codex", would_action: "nudge_continue", injected: true });
  await writeFile(file, `${first}\n${second}`);
  assert.equal((await collectNudges(directory, home)).length, 1);
  await writeFile(file, `${first}\n${second}\n`);
  assert.equal((await collectNudges(directory, home)).length, 2);
  await rename(file, `${file}.old`); await writeFile(file, `${second}\n`);
  assert.equal((await collectNudges(directory, home)).length, 2);
  assert.equal((await readFile(path.join(directory, "autopilot.json"), "utf8")).includes("not exported"), false);
});

test("Screams persist as user events, repeated clicks count, and undo removes only the targeted event", async (t) => {
  const directory = await temporary(t);
  const first = await appendEvent(directory, { type: "scream", at, model: "model-a" });
  await appendEvent(directory, { type: "scream", at, model: "model-a" });
  await appendEvent(directory, { type: "scream_undo", at, target: first.id });
  const events = await readUserEvents(directory); assert.equal(events.length, 1);
  const stats = eventStatistics(events, { today: row.day });
  assert.equal(stats.screams[0].week, 1); assert.equal(stats.screams[0].month, 1); assert.equal(stats.screams[0].year, 1);
});

test("session resolution keeps absent identity unknown instead of selecting a recent unrelated session", async () => {
  const resolved = await resolveSession({ foreground: { name: "codex", argv: ["codex"], cwd: "/same" }, status: { app: "codex" } }, "/nonexistent");
  assert.equal(resolved.sessionId, ""); assert.equal(resolved.model, "unknown");
});

test("Cursor opaque login uses its account profile and never persists credentials", async (t) => {
  const home = await temporary(t), directory = path.join(home, ".config/Cursor/User/globalStorage");
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)");
  const put = db.prepare("INSERT INTO ItemTable VALUES(?,?)");
  put.run("cursorAuth/accessToken", "opaque-fixture-token");
  put.run("cursorAuth/cachedScopedProfile", JSON.stringify({ authId: "auth0|fixture-user" })); db.close();
  const store = path.join(home, "data/insights.json");
  const result = await cursorSnapshot(store, home, { refresh: true, fetcher: async (url, options) => {
    assert.equal(new URL(url).hostname, "cursor.com");
    assert.equal(options.headers.Cookie, "WorkosCursorSessionToken=fixture-user::opaque-fixture-token");
    return new Response("Date,Model,Total Tokens\n2026-11-05T12:00:00Z,model-a,42\n");
  } });
  assert.equal(result.rows[0].tokens.total, 42); assert.deepEqual(result.warnings, []);
  const persisted = await readFile(path.join(home, "data/cursor-account.json"), "utf8");
  assert.equal(persisted.includes("opaque-fixture-token"), false); assert.equal(persisted.includes("fixture-user"), false);
});

test("chicken button precedes native right controls, reacts immediately, and never blocks repeated clicks", () => {
  const source = 'import { image } from "gpui-kit";\nconst ui = row.child(button("tab-new", "+"));';
  const result = withScreamControl(source);
  assert.ok(result.indexOf('.id("insights-scream-chicken")') < result.indexOf('.child(button("tab-new",'));
  assert.match(result, /playSound\("mods\/insights\/scream.wav"\)/);
  assert.match(result, /scream-chicken-pressed\.svg/);
  assert.doesNotMatch(result, /Saving|screamBusy|undo|lastScream/);
  assert.throws(() => withScreamControl("unsupported tabs"));
});

test("Codex model comes from the actual footer, not a model mentioned in a prompt", () => {
  const classic = "GPT-6.1-Sol high · ~/work · Task · Main [default]";
  const modern = "Context 20% used · 475K window · GPT-6-Astra high · weekly 60% left";
  assert.equal(codexFooterModel(classic), "gpt-6.1-sol");
  assert.equal(codexFooterModel(modern), "gpt-6-astra");
  assert.equal(codexFooterModel("› use GPT-6-Astra high · Main"), null);
  assert.equal(codexFooterModel("The config model is gpt-6-astra"), null);
  assert.equal(codexFooterModel("› GPT-6-Astra high · Main\n" + classic), "gpt-6.1-sol");
  assert.equal(codexFooterModel(classic + "\n".repeat(10) + "unrelated output"), null, "old scrollback is not current model evidence");
});

test("new local Codex feedback records a verified footer model while leaving unproven session identity empty", async (t) => {
  const directory = await temporary(t);
  const terminal = { status: { app: "codex" }, foreground: { pid: 100, name: "codex", argv: ["codex"] } };
  const event = await captureScream(directory, { terminal: "t2", machine: null }, {
    runner: async (_program, args) => args[0] === "get" ? JSON.stringify(terminal)
      : "PRIVATE_PROMPT\nGPT-6.1-Sol high · ~/work · Task · Main [default]",
    resolver: async () => ({ tool: "codex", sessionId: "", model: "unknown", attribution: "unknown" }),
  });
  assert.equal(event.model, "gpt-6.1-sol"); assert.equal(event.modelEvidence, "terminal-footer"); assert.equal(event.sessionId, "");
  const raw = await readFile(path.join(directory, "events.jsonl"), "utf8");
  assert.equal(raw.includes("PRIVATE_PROMPT"), false);
});

test("clearing feedback preserves usage/nudges, excludes late old clicks, and accepts every new click", async (t) => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, "insights.json"), "usage history");
  await appendEvent(directory, { type: "scream", at, model: "unknown" });
  await appendEvent(directory, { type: "nudge_continue", at, model: "unknown" });
  const result = await clearScreams(directory);
  assert.equal(result.removed, 1); assert.deepEqual(await readUserEvents(directory), []);
  await appendEvent(directory, { type: "scream", at, model: "unknown" });
  assert.deepEqual(await readUserEvents(directory), [], "an old click resolving after clear must not reappear");
  await Promise.all(Array.from({ length: 6 }, () => appendEvent(directory, {
    type: "scream", at: new Date(Date.parse(result.clearedAt) + 1000).toISOString(), model: "gpt-6.1-sol",
  })));
  assert.equal((await readUserEvents(directory)).length, 6);
  assert.equal(await readFile(path.join(directory, "insights.json"), "utf8"), "usage history");
  const rows = (await readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((row) => row.type === "nudge_continue").length, 1);
});
