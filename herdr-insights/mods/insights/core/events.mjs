import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWriteJson, hashKey, localDay, withStoreLock } from "./util.mjs";

export function cleanEvent(value) {
  if (!value || !["scream", "scream_undo", "nudge_continue"].includes(value.type)
    || typeof value.id !== "string" || !Number.isFinite(Date.parse(value.at))) throw new Error("Invalid Insights event");
  const text = (field, fallback = "unknown") => typeof value[field] === "string" && value[field].length <= 4096 ? value[field] : fallback;
  return { id: text("id"), type: value.type, at: new Date(value.at).toISOString(), day: localDay(Date.parse(value.at)),
    machine: text("machine", "local"), terminal: text("terminal", ""), tool: text("tool"), sessionId: text("sessionId", ""),
    model: text("model"), origin: text("origin", "user"), outcome: text("outcome", "recorded"),
    attribution: text("attribution", "unknown"), target: text("target", "") };
}

export async function appendEvent(directory, value) {
  const event = cleanEvent({ ...value, id: value.id ?? randomUUID(), at: value.at ?? new Date().toISOString() });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

export async function readUserEvents(directory) {
  try {
    const rows = (await readFile(path.join(directory, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
    const events = rows.map((row) => { try { return cleanEvent(JSON.parse(row)); } catch { return null; } }).filter(Boolean);
    const undone = new Set(events.filter((event) => event.type === "scream_undo").map((event) => event.target));
    return events.filter((event) => event.type === "scream" && !undone.has(event.id));
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function nudgeEvent(row, origin) {
  const action = origin === "shepherd" ? row.would_action ?? row.action : row.action;
  if (!(action === "nudge_continue" || (origin === "stop-hook" && action === "continue"))) return null;
  const at = row.ts ?? row.timestamp ?? row.at;
  if (!Number.isFinite(Date.parse(at))) return null;
  let outcome = "held";
  if (row.dry_run !== true) {
    if (origin === "shepherd" && row.injected === true) outcome = "sent";
    else if (origin === "stop-hook" && (row.counted === true || row.continued === true) && row.result === "continue") outcome = "issued";
    else if (origin === "shepherd" && Object.hasOwn(row, "inject_error")) outcome = "attempted";
  }
  return cleanEvent({ id: hashKey("autopilot", canonical(row)), type: "nudge_continue", at,
    tool: row.agent === "claude-code" ? "claude" : row.agent, origin: origin === "stop-hook" ? `stop-hook:${row.caller ?? row.agent ?? "unknown"}` : origin, outcome,
    terminal: row.pane_id ?? "", sessionId: row.session ? hashKey("session", row.session) : "",
    // Hook `model` is the judge model, not the coding agent's model.
    model: row.agent_model ?? "unknown", attribution: row.agent_model ? "explicit-event" : "unknown" });
}

const LOGS = [
  [".local/state/herdr-autopilot/decisions.jsonl", "shepherd"],
  [".local/state/herdr-autopilot-hc/decisions.jsonl", "shepherd"],
  [".local/state/pi-settle-judge/decisions.jsonl", "stop-hook"],
];

/** Retain normalized events even after the producer prunes or rewrites logs. */
export async function collectNudges(directory, home) {
  const cachePath = path.join(directory, "autopilot.json");
  let cache = { version: 1, files: {}, events: {} };
  try { cache = JSON.parse(await readFile(cachePath, "utf8")); if (cache.version !== 1 || !cache.events || !cache.files) throw new Error("Invalid autopilot history"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await withStoreLock(cachePath, async () => {
    try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let dirty = false;
    for (const [relative, origin] of LOGS) {
      const file = path.join(home, relative);
      let info;
      try { info = await stat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const previous = cache.files[relative];
      let offset = previous?.ino === String(info.ino) && previous.size <= info.size ? previous.size : 0;
      if (offset === info.size) continue;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(info.size - offset, 32 * 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        let start = 0;
        for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
          const line = buffer.subarray(start, end).toString("utf8");
          offset += end - start + 1; start = end + 1;
          try { const event = nudgeEvent(JSON.parse(line), origin); if (event && !cache.events[event.id]) { cache.events[event.id] = event; dirty = true; } } catch { /* Malformed producer record. */ }
        }
      } finally { await handle.close(); }
      cache.files[relative] = { ino: String(info.ino), size: offset }; dirty = true;
    }
    if (dirty) await atomicWriteJson(cachePath, cache);
  }, { timeoutMs: 0 });
  return Object.values(cache.events).map(cleanEvent);
}
