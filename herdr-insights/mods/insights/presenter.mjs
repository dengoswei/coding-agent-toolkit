#!/usr/bin/env node
// Node presentation helper for Insights.
//
// QuickJS receives only a compact dashboard payload. The full snapshot rows and
// the pure analytics derivation stay in Node, where a filter change can also be
// prepared from the existing store without scanning transcripts again.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESENTATION_VERSION,
  compactDashboard,
  deriveDashboard,
} from "./analytics.js";
import { collectSnapshot, readCommittedSnapshot } from "./collector.mjs";
import { fleetSnapshots, mergeFleet } from "./core/fleet.mjs";
import { cursorSnapshot } from "./core/cursor.mjs";
import { collectNudges, readUserEvents } from "./core/events.mjs";
import { readFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  presenter.mjs snapshot --store <file> --home <dir> [--options <json>]",
    "  presenter.mjs configure --store <file> --home <dir> --config <json> [--options <json>]",
    "  presenter.mjs prepare --store <file> [--options <json>]",
    "  presenter.mjs status --store <file> [--options <json>]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const match = /^--(store|home|config|options)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    options[key] = value;
  }
  return { command, options };
}

function parseOptions(raw) {
  if (raw === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const invalid = new Error(`invalid --options: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const invalid = new Error("invalid --options: expected one JSON object");
    invalid.exitCode = 2;
    throw invalid;
  }
  return parsed;
}

function compactSnapshot(snapshot, rowCount = 0) {
  const {
    version = 1,
    generatedAt = null,
    lastScanAt = null,
    lastCompletedScanAt = null,
    savedAt = null,
    config = {},
    stats,
    sourceStats,
    scan,
    warnings = [],
    machines = [],
  } = snapshot ?? {};
  return {
    version,
    generatedAt,
    lastScanAt,
    lastCompletedScanAt,
    savedAt,
    config,
    rowCount: Array.isArray(snapshot?.rows)
      ? snapshot.rows.length
      : Number.isFinite(Number(rowCount))
        ? Number(rowCount)
        : 0,
    stats,
    sourceStats,
    scan: scan && typeof scan === "object" ? scan : null,
    warnings: Array.isArray(warnings) ? warnings : [],
    machines,
  };
}

function presentation(command, snapshot, options, dashboard, error) {
  return {
    version: PRESENTATION_VERSION,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshot(snapshot),
    dashboard: dashboard ? compactDashboard(dashboard) : null,
    error: error ? String(error.message ?? error) : null,
  };
}

function derive(snapshot, options) {
  try {
    return { dashboard: deriveDashboard(snapshot, options), error: null };
  } catch (error) {
    return { dashboard: null, error };
  }
}

export async function run(argv, environment = {}) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    return { exitCode: 0, stdout: "", stderr: `${usage()}\n` };
  }
  if (!["snapshot", "configure", "prepare", "status"].includes(command)) {
    return { exitCode: 2, stdout: "", stderr: `unknown command ${command}\n${usage()}\n` };
  }
  if (!options.store) {
    return { exitCode: 2, stdout: "", stderr: "--store is required\n" };
  }
  if (command === "configure" && options.config === undefined) {
    return { exitCode: 2, stdout: "", stderr: "--config is required\n" };
  }

  const storePath = path.resolve(options.store);
  const home = path.resolve(options.home ?? environment.home ?? os.homedir());
  const dashboardOptions = parseOptions(options.options);
  let integrations = false;
  try { integrations = JSON.parse(await readFile(path.join(path.dirname(storePath), "integrations.json"), "utf8")).enabled === true; } catch { /* Opt-in only. */ }

  if (command === "prepare" || command === "status") {
    // Never takes the writer lock: a long indexer must not block the cached UI.
    const local = await readCommittedSnapshot(storePath);
    const snapshot = integrations ? await enrichedSnapshot(local, storePath, home) : local;
    const derived = derive(snapshot, dashboardOptions);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(presentation(command, snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`,
      stderr: "",
    };
  }

  const collect = collectSnapshot(command, { store: storePath, home, config: options.config });
  const snapshot = integrations
    ? await Promise.all([collect, fleetSnapshots(storePath, { refresh: true }), cursorSnapshot(storePath, home, { refresh: true }),
      collectNudges(path.dirname(storePath), home).catch(() => [])])
      .then(([local, fleet, cursor, nudges]) => enrichedSnapshot(local, storePath, home, { fleet, cursor, nudges }))
    : await collect;
  const derived = derive(snapshot, dashboardOptions);
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(presentation(command, snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`,
    stderr: "",
  };
}

async function enrichedSnapshot(local, storePath, home, supplied = {}) {
  const [fleet, cursor, screams] = await Promise.all([
    supplied.fleet ?? fleetSnapshots(storePath), supplied.cursor ?? cursorSnapshot(storePath, home), readUserEvents(path.dirname(storePath)),
  ]);
  let nudges = supplied.nudges;
  if (!nudges) {
    try { const saved = JSON.parse(await readFile(path.join(path.dirname(storePath), "autopilot.json"), "utf8")); nudges = Object.values(saved.events ?? {}); }
    catch { nudges = []; }
  }
  const merged = mergeFleet(local, fleet);
  merged.rows.push(...cursor.rows); merged.machines.push(...cursor.machines);
  merged.events.push(...nudges, ...screams); merged.warnings.push(...cursor.warnings);
  return merged;
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error.stderr) process.stderr.write(String(error.stderr));
    else process.stderr.write(`insights presenter: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isEntryPoint()) await main();
