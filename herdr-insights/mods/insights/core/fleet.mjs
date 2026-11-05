// Local orchestration of Herdr's connected machines. Only normalized metadata
// crosses the core connection; transcripts and credentials stay on their host.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, hashKey, isLockBusyError, withStoreLock } from "./util.mjs";
import { cleanEvent } from "./events.mjs";

const MOD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_BYTES = 64 * 1024 * 1024;
export const REMOTE_PROTOCOL = 1;

export function execute(program, args, { input, timeout = 24000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", bytes = 0, failure = null;
    const timer = setTimeout(() => { failure = new Error("Remote request timed out"); child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT_BYTES) { failure = new Error("Remote response exceeds limit"); child.kill("SIGKILL"); }
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Helper exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function text(value, fallback = "unknown") {
  return typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) ? value : fallback;
}
function counter(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid usage counter");
  return value;
}

/** Explicit allowlist: never persist arbitrary remote JSON or source records. */
export function usageRows(rows) {
  if (!Array.isArray(rows) || rows.length > 500000) throw new Error("Invalid remote rows");
  return rows.map((row) => {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new Error("Invalid usage day");
    const tokens = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) tokens[key] = counter(row.tokens?.[key] ?? 0);
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return { day: row.day, session: text(row.session, ""), harness: text(row.harness),
      provider: text(row.provider), model: text(row.model), project: text(row.project, ""), tokens,
      messages: counter(row.messages ?? 0), activeMs: counter(row.activeMs ?? 0), longestTaskMs: counter(row.longestTaskMs ?? 0) };
  });
}

export function exportSnapshot(snapshot, timezone, events = []) {
  return { version: REMOTE_PROTOCOL, kind: "insights-remote", timezone,
    generatedAt: snapshot.generatedAt, lastCompletedScanAt: snapshot.lastCompletedScanAt,
    scan: { status: text(snapshot.scan?.status), processed: counter(snapshot.scan?.processed ?? 0), total: counter(snapshot.scan?.total ?? 0) },
    rows: usageRows(snapshot.rows), events: events.map(cleanEvent) };
}

export function validateExport(value, timezone) {
  if (value?.version !== REMOTE_PROTOCOL || value.kind !== "insights-remote" || value.timezone !== timezone
    || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error("Incompatible remote snapshot");
  const clean = exportSnapshot({ ...value, rows: usageRows(value.rows) }, timezone);
  // Event validation is centralized with locally captured events.
  if (!Array.isArray(value.events) || value.events.length > 500000) throw new Error("Invalid remote events");
  clean.events = value.events.map(cleanEvent);
  return clean;
}

async function readRegistry(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== 1 || !value.machines || typeof value.machines !== "object" || Array.isArray(value.machines)) throw new Error("Invalid machine history");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, machines: {} };
    throw error;
  }
}

async function collectorBundle() {
  const files = {};
  for (const name of ["collector.mjs", "indexer.mjs", "remote-export.mjs"]) files[name] = await readFile(path.join(MOD_ROOT, name), "utf8");
  for (const name of (await readdir(path.join(MOD_ROOT, "core"))).sort()) {
    if (name.endsWith(".mjs")) files[`core/${name}`] = await readFile(path.join(MOD_ROOT, "core", name), "utf8");
  }
  return { files, revision: hashKey(files) };
}

// Constant program; all variable data arrives as JSON stdin, never shell text.
const DEPLOY = `const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
(async()=>{let data='';for await(const c of process.stdin)data+=c;const b=JSON.parse(data);
const root=path.join(os.homedir(),'.cache','herdr-insights','collectors',b.revision);
await fs.mkdir(root,{recursive:true,mode:448});
for(const [name,content]of Object.entries(b.files)){if(!/^(?:core\\/)?[a-z-]+\\.mjs$/.test(name))throw Error('Invalid file');
const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:448});
try{await fs.writeFile(target,content,{flag:'wx',mode:384});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(target,'utf8')!==content)throw e;}}
console.log(JSON.stringify({node:process.execPath,bundle:root}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`;

export async function syncMachine(machine, previous, bundle, timezone, runner = execute) {
  const deadline = Date.now() + 24000;
  const remaining = (maximum) => Math.max(1, Math.min(maximum, deadline - Date.now()));
  let runtime = previous?.runtime;
  if (!runtime || runtime.revision !== bundle.revision) {
    const node = (await runner("hc", ["exec", "--on", machine.name, "--timeout", "5", "--", "sh", "-lc", "command -v node"], { timeout: remaining(7000) })).trim();
    if (!node.startsWith("/") || /[\r\n\0]/.test(node)) throw new Error("Remote Node executable is unavailable");
    runtime = { ...JSON.parse(await runner("hc", ["exec", "--on", machine.name, "--timeout", "5", "-i", "--", node, "-e", DEPLOY],
      { input: JSON.stringify(bundle), timeout: remaining(7000) })), revision: bundle.revision };
  }
  const raw = await runner("hc", ["exec", "--on", machine.name, "--timeout", "18", "--env", `TZ=${timezone}`, "--", runtime.node,
    path.join(runtime.bundle, "remote-export.mjs")], { timeout: remaining(21000) });
  const incoming = validateExport(JSON.parse(raw), timezone);
  // Retain accepted history even if a remote store is reset or logs disappear.
  // Repeated buckets replace previous values, never add the same export twice.
  const bucketKey = (row) => JSON.stringify([row.day, row.session, row.harness, row.provider, row.model, row.project]);
  const rows = new Map((previous?.snapshot?.timezone === timezone ? previous.snapshot.rows : []).map((row) => [bucketKey(row), row]));
  for (const row of incoming.rows) rows.set(bucketKey(row), row);
  const events = new Map((previous?.snapshot?.events ?? []).map((event) => [event.id, cleanEvent(event)]));
  for (const event of incoming.events) events.set(event.id, event);
  incoming.rows = [...rows.values()]; incoming.events = [...events.values()];
  return { runtime, snapshot: incoming, syncedAt: new Date().toISOString(), error: null };
}

/** Discovery is dynamic. Removed/offline hosts stay in the registry indefinitely. */
export async function fleetSnapshots(storePath, { refresh = false, runner = execute, now = Date.now() } = {}) {
  const file = path.join(path.dirname(storePath), "fleet.json");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const warnings = [];
  let registry = await readRegistry(file);
  let connectionKnown = false;
  if (refresh) {
    try {
      await withStoreLock(file, async () => {
        registry = await readRegistry(file);
        const discovery = JSON.parse(await runner("hc", ["machine", "ls"], { timeout: 3000 }));
        if (!Array.isArray(discovery.machines)) throw new Error("Invalid Herdr machine list");
        connectionKnown = true;
        for (const value of Object.values(registry.machines)) value.connected = false;
        for (const machine of discovery.machines) {
          if (machine.temporary || !machine.id || !machine.name) continue;
          const key = hashKey("machine", machine.id);
          const previous = registry.machines[key];
          registry.machines[key] = { ...previous, id: machine.id, name: machine.name,
            connected: machine.state === "connected", lastSeenAt: new Date(now).toISOString() };
        }
        const due = Object.values(registry.machines).filter((machine) => machine.connected
          && (machine.snapshot?.timezone !== timezone || now - Date.parse(machine.attemptedAt ?? 0) >=
            (["partial", "running", "starting"].includes(machine.snapshot?.scan?.status) && !machine.error ? 3000 : 60000)));
        // At most two concurrent remote requests keep each refresh bounded.
        due.sort((a, b) => Date.parse(a.attemptedAt ?? 0) - Date.parse(b.attemptedAt ?? 0));
        if (due.length) {
          const bundle = await collectorBundle();
          await Promise.all(due.slice(0, 2).map(async (machine) => {
            machine.attemptedAt = new Date(now).toISOString();
            try { Object.assign(machine, await syncMachine(machine, machine, bundle, timezone, runner)); }
            catch { machine.error = "Remote refresh failed; showing the last successful snapshot."; }
          }));
        }
        await atomicWriteJson(file, registry);
      }, { timeoutMs: 0 });
    } catch (error) {
      warnings.push(isLockBusyError(error) ? "Remote refresh already in progress." : "Cannot refresh Herdr machines; retained machine history is shown.");
    }
  }
  const rows = [], machines = [], events = [];
  for (const machine of Object.values(registry.machines)) {
    let snapshot = null;
    try { if (machine.snapshot?.timezone === timezone) snapshot = validateExport(machine.snapshot, timezone); }
    catch { warnings.push(`Invalid cached snapshot for ${text(machine.name)}.`); }
    const name = text(machine.name), id = `remote:${text(machine.id)}`;
    const status = !machine.connected ? "offline" : machine.error ? "stale" : snapshot?.scan?.status ?? "pending";
    machines.push({ id, name, status, syncedAt: machine.syncedAt ?? null, lastCompletedScanAt: snapshot?.lastCompletedScanAt ?? null,
      processed: snapshot?.scan?.processed ?? 0, total: snapshot?.scan?.total ?? 0, error: machine.error ?? null });
    if (machine.error) warnings.push(`${name}: ${machine.error}`);
    for (const row of snapshot?.rows ?? []) rows.push({ ...row, machine: id, session: row.session ? `${id}:${row.session}` : "" });
    for (const event of snapshot?.events ?? []) events.push({ ...event, machine: id });
  }
  return { rows, machines, events, warnings, connectionKnown };
}

export function mergeFleet(local, fleet) {
  return { ...local, rows: [...local.rows.map((row) => ({ ...row, machine: "local", session: row.session ? `local:${row.session}` : "" })), ...fleet.rows],
    machines: [{ id: "local", name: "This Mac", status: local.scan?.status ?? "complete", lastCompletedScanAt: local.lastCompletedScanAt }, ...fleet.machines],
    events: fleet.events, warnings: [...(local.warnings ?? []), ...fleet.warnings] };
}
