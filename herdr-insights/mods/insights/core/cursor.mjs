// Cursor's local billing cache is account-wide, not attributable to a session
// or machine. Never substitute context-window occupancy for consumed tokens.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, localDay, withStoreLock } from "./util.mjs";

export function parseBillingCache(value) {
  const rows = new Map();
  for (const chart of value?.charts ?? []) {
    if (chart.spendType !== "all" || !Number.isFinite(Number(chart.fetchedAt))) continue;
    let response;
    try { response = typeof chart.response === "string" ? JSON.parse(chart.response) : chart.response; } catch { continue; }
    for (const item of response?.dailySpend ?? []) {
      const timestamp = Number(item.day), total = Number(item.totalTokens);
      if (!Number.isFinite(timestamp) || timestamp < 1e12 || !Number.isSafeInteger(total) || total < 0 || typeof item.category !== "string") continue;
      const day = localDay(timestamp), key = `${day}\0${item.category}`;
      if ((rows.get(key)?.observedAt ?? 0) > Number(chart.fetchedAt)) continue;
      rows.set(key, { day, model: item.category, tokens: { total }, observedAt: Number(chart.fetchedAt), origin: "billing-cache" });
    }
  }
  return [...rows.values()];
}

export function parseCsv(csv) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') { if (quoted && csv[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if (ch === "\n" && !quoted) { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (quoted) throw new Error("Incomplete Cursor CSV");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export function parseUsageCsv(csv, observedAt = Date.now()) {
  const [header, ...records] = parseCsv(csv);
  if (!header?.includes("Date") || !header.includes("Model") || !header.includes("Total Tokens")) throw new Error("Unsupported Cursor usage export");
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const rows = new Map();
  for (const record of records) {
    if (!record.some(Boolean)) continue;
    const timestamp = Date.parse(record[index.Date]);
    const model = record[index.Model], total = Number(record[index["Total Tokens"]]);
    if (!Number.isFinite(timestamp) || !model || !Number.isSafeInteger(total) || total < 0) continue;
    const day = localDay(timestamp), key = `${day}\0${model}`;
    const row = rows.get(key) ?? { day, model, tokens: { total: 0 }, observedAt, origin: "account-export" };
    row.tokens.total += total;
    rows.set(key, row);
  }
  return [...rows.values()];
}

async function readLocal(home) {
  const locations = [path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
    path.join(home, ".config/Cursor/User/globalStorage/state.vscdb")];
  const { DatabaseSync } = await import("node:sqlite");
  for (const location of locations) {
    let db;
    try {
      db = new DatabaseSync(location, { readOnly: true });
      const get = (key) => { const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key); return row ? String(row.value) : null; };
      const cached = get("aiSettings.enterprisePlanUsageSnapshot");
      let authId = null;
      try { authId = JSON.parse(get("cursorAuth/cachedScopedProfile"))?.authId ?? null; } catch { /* Legacy Cursor has a JWT subject instead. */ }
      return { rows: cached ? parseBillingCache(JSON.parse(cached)) : [], token: get("cursorAuth/accessToken"), authId };
    } catch { /* Missing database or cache: try the next platform location. */ }
    finally { db?.close(); }
  }
  return { rows: [], token: null };
}

async function liveRows(token, fetcher, authId) {
  let subject = authId;
  if (token.split(".").length === 3) {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp && payload.exp * 1000 <= Date.now()) throw new Error("Cursor login expired");
    subject = payload.sub ?? subject;
  }
  if (typeof subject !== "string" || !subject) throw new Error("Cursor local login format unsupported");
  const user = subject.replace(/^auth0\|/, "");
  const response = await fetcher("https://cursor.com/api/dashboard/export-usage-events-csv?strategy=requests", {
    headers: { Cookie: `WorkosCursorSessionToken=${user}::${token}`, Accept: "text/csv", Referer: "https://cursor.com/dashboard/usage" },
    signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Cursor usage HTTP ${response.status}`);
  const csv = await response.text();
  if (csv.length > 32 * 1024 * 1024) throw new Error("Cursor export exceeds limit");
  return parseUsageCsv(csv);
}

export async function cursorSnapshot(storePath, home, { refresh = false, fetcher = fetch } = {}) {
  const file = path.join(path.dirname(storePath), "cursor-account.json");
  let cache = { version: 1, rows: [], attemptedAt: null, error: null };
  try { cache = JSON.parse(await readFile(file, "utf8")); if (cache.version !== 1 || !Array.isArray(cache.rows)) throw new Error("Invalid Cursor cache"); }
  catch (error) { if (error.code !== "ENOENT") return { rows: [], warnings: ["Cursor usage cache could not be read; it was preserved."], machines: [] }; }
  if (refresh && Date.now() - Date.parse(cache.attemptedAt ?? 0) > 60000) {
    try {
      await withStoreLock(file, async () => {
        try { cache = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const local = await readLocal(home);
        const rows = new Map(cache.rows.map((row) => [`${row.day}\0${row.model}`, row]));
        const liveDays = new Map(cache.rows.filter((row) => row.origin === "account-export").map((row) => [row.day, row.observedAt]));
        for (const row of local.rows) {
          if ((liveDays.get(row.day) ?? 0) >= row.observedAt) continue;
          if ((rows.get(`${row.day}\0${row.model}`)?.observedAt ?? 0) <= row.observedAt) rows.set(`${row.day}\0${row.model}`, row);
        }
        cache.error = null;
        if (local.token) {
          try {
            const incoming = await liveRows(local.token, fetcher, local.authId);
            const days = new Set(incoming.map((row) => row.day));
            // The two account sources may use different model display names.
            // One export owns a day's totals; never add both representations.
            for (const [key, row] of rows) if (days.has(row.day)) rows.delete(key);
            for (const row of incoming) rows.set(`${row.day}\0${row.model}`, row);
          }
          catch (error) {
            const reason = /Cursor login expired|Cursor local login format unsupported|Cursor usage HTTP \d{3}/.exec(error.message)?.[0];
            cache.error = reason ? `${reason}; showing retained billing data.` : "Cursor live usage unavailable; showing retained billing data.";
          }
        } else cache.error = "Cursor has no active local login; showing retained billing data.";
        cache.rows = [...rows.values()]; cache.attemptedAt = new Date().toISOString();
        await atomicWriteJson(file, cache);
      }, { timeoutMs: 0 });
    } catch { cache.error = "Cursor refresh unavailable; showing retained billing data."; }
  }
  const newest = Math.max(0, ...cache.rows.map((row) => row.observedAt ?? 0));
  return { rows: cache.rows.map((row) => ({ day: row.day, session: "", machine: "cursor-account", harness: "cursor", provider: "cursor",
    model: row.model, project: "", tokens: { total: row.tokens.total }, messages: 0, activeMs: 0, longestTaskMs: 0 })),
  machines: [{ id: "cursor-account", name: "Cursor account", origin: "account billing data", status: cache.error ? "stale" : "account-wide",
    syncedAt: newest ? new Date(newest).toISOString() : null, error: cache.error,
    coverage: cache.rows.length ? `${cache.rows.map((row) => row.day).sort()[0]} – ${cache.rows.map((row) => row.day).sort().at(-1)}` : "No cached usage" }],
  warnings: cache.error ? [cache.error] : [] };
}
