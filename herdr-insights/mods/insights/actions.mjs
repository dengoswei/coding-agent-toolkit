import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendEvent } from "./core/events.mjs";
import { execute } from "./core/fleet.mjs";
import { resolveSession } from "./core/session.mjs";

const [command, directory, raw] = process.argv.slice(2);
if (!directory || !["scream", "undo"].includes(command)) throw new Error("Invalid Insights action");
const request = JSON.parse(raw ?? "{}");
if (command === "undo") {
  if (typeof request.id !== "string") throw new Error("Missing event ID");
  const event = await appendEvent(directory, { type: "scream_undo", target: request.id });
  console.log(JSON.stringify(event));
} else {
  if (typeof request.terminal !== "string" || !request.terminal) throw new Error("Focus an agent terminal before recording a Scream");
  const terminal = JSON.parse(await execute("hc", ["get", request.terminal], { timeout: 3000 }));
  if (!terminal.status?.app) throw new Error("Focus an agent terminal before recording a Scream");
  let info = { tool: terminal.status?.app ?? terminal.foreground?.name ?? "unknown", sessionId: "", model: "unknown", attribution: "unknown" };
  let machineId = "local";
  if (request.machine) {
    const list = JSON.parse(await execute("hc", ["machine", "ls"], { timeout: 3000 }));
    const machine = list.machines?.find((item) => !item.temporary && (item.name === request.machine || item.id === request.machine
      || request.terminal.startsWith(`${item.name}/`)));
    machineId = `remote-unresolved:${request.machine}`;
    if (machine) {
      machineId = `remote:${machine.id}`;
      try {
        const fleet = JSON.parse(await readFile(path.join(directory, "fleet.json"), "utf8"));
        const runtime = Object.values(fleet.machines).find((item) => item.id === machine.id)?.runtime;
        if (runtime) info = JSON.parse(await execute("hc", ["exec", "--on", machine.name, "--timeout", "5", "--", runtime.node,
          path.join(runtime.bundle, "core/session.mjs"), JSON.stringify(terminal)], { timeout: 7000 }));
      } catch { /* The terminal still identifies the captured event when offline. */ }
    }
  } else info = await resolveSession(terminal);
  const current = JSON.parse(await execute("hc", ["get", request.terminal], { timeout: 3000 }));
  if (current.foreground?.pid !== terminal.foreground?.pid) info = { tool: "unknown", sessionId: "", model: "unknown", attribution: "process-changed" };
  const event = await appendEvent(directory, { type: "scream", at: request.at, machine: machineId, terminal: request.terminal, ...info });
  console.log(JSON.stringify(event));
}
