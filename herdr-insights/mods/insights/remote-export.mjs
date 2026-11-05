// Runs only on the selected Herdr machine. Its persistent store stays there.
import os from "node:os";
import path from "node:path";
import { collectSnapshot } from "./collector.mjs";
import { exportSnapshot } from "./core/fleet.mjs";
import { hashKey } from "./core/util.mjs";
import { collectNudges } from "./core/events.mjs";

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const store = path.join(os.homedir(), ".cache", "herdr-insights", "data", hashKey(timezone), "insights.json");
const snapshot = await collectSnapshot("snapshot", { store, home: os.homedir(), budgetMs: 8000, lockWaitMs: 0, workerAckMs: 0 });
const events = await collectNudges(path.dirname(store), os.homedir());
console.log(JSON.stringify(exportSnapshot(snapshot, timezone, events)));
