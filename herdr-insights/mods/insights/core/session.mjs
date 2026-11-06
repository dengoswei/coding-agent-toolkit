// Resolve only process-linked evidence. Directory recency is never identity.
import { readFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read the displayed Codex status bar, never a default or a model in chat text. */
export function codexFooterModel(screen) {
  if (typeof screen !== "string") return null;
  const plain = screen.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const footer = plain.split(/\r?\n/).slice(-8).reverse();
  for (const line of footer) {
    if (/^\s*[›>$#|]/.test(line) || !line.includes("·")) continue;
    if (!/\b(?:context|window|weekly|remaining|Main)\b/i.test(line)) continue;
    for (const part of line.split("·")) {
      const match = /^\s*((?:gpt|codex|claude|gemini|deepseek|qwen|kimi|glm)[\w.\-:/+]+|o\d[\w.\-:/+]*)\s+(?:minimal|low|medium|high|xhigh|max|ultra)\s*$/i.exec(part);
      if (match) return match[1].toLowerCase();
    }
  }
  return null;
}

export async function resolveSession(terminal, home = os.homedir()) {
  const foreground = terminal.foreground ?? {};
  const args = Array.isArray(foreground.argv) ? foreground.argv : [];
  const toolName = terminal.status?.app ?? foreground.name ?? "unknown";
  const tool = toolName === "claude-code" ? "claude" : toolName;
  const labels = terminal.labels ?? {};
  let sessionId = labels["insights.session"] ?? labels["agent.session"] ?? null;
  let model = labels["insights.model"] ?? null;
  let attribution = sessionId ? "explicit-label" : "unknown";
  if (tool === "claude" && Number.isInteger(foreground.pid)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(home, ".claude/sessions", `${foreground.pid}.json`), "utf8"));
      const proc = await readFile(`/proc/${foreground.pid}/stat`, "utf8");
      const start = proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19];
      if (metadata.pid === foreground.pid && metadata.cwd === foreground.cwd && String(metadata.procStart) === start
        && typeof metadata.sessionId === "string") { sessionId = metadata.sessionId; attribution = "process-metadata"; }
    } catch { /* No exact current-session metadata. */ }
  }
  if (!sessionId) {
    for (let i = 0; i < args.length - 1; i++) {
      if (["resume", "--resume", "--session-id"].includes(args[i]) && /^[a-f0-9-]{32,36}$/i.test(args[i + 1])) {
        sessionId = args[i + 1]; attribution = "launch-argument"; break;
      }
    }
  }
  for (let i = 0; !model && i < args.length - 1; i++) if (["--model", "-m"].includes(args[i])) model = args[i + 1];
  if (tool === "codex" && sessionId) {
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(path.join(home, ".codex/state_5.sqlite"), { readOnly: true });
      const row = db.prepare("SELECT model FROM threads WHERE id = ?").get(sessionId);
      if (typeof row?.model === "string") model = row.model;
    } catch { /* Model stays unknown; do not guess from another session. */ }
    finally { db?.close(); }
  }
  if (tool === "claude" && sessionId && foreground.cwd) {
    let file;
    try {
      file = await open(path.join(home, ".claude/projects", foreground.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`), "r");
      const info = await file.stat(), buffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
      await file.read(buffer, 0, buffer.length, info.size - buffer.length);
      for (const line of buffer.toString("utf8").split("\n")) {
        try { const row = JSON.parse(line); if (row.type === "assistant" && typeof row.message?.model === "string") model = row.message.model; } catch { /* First line may be partial. */ }
      }
    } catch { /* Exact transcript unavailable. */ }
    finally { await file?.close(); }
  }
  return { tool, sessionId: sessionId ?? "", model: model ?? "unknown", attribution };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await resolveSession(JSON.parse(process.argv[2]))));
