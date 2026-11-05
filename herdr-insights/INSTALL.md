# Install Insights

Requires **Node.js 22.15+** and a running Herdr. Never launch a second Herdr instance.
Follow Herdr's `AGENTS.md`; this guide does not override its review requirements.
Use this existing build, not `RECIPE.md` (rebuilding).

## Install

From the parent of `herdr-insights/`; no `npm install` needed:

```sh
npm run install:local --prefix herdr-insights
```

This fork's optional extensions are enabled with `-- --integrations`. They discover
connected Herdr machines dynamically, retain offline history, read Cursor account
usage, and add a Scream feedback control without adding keys. Details and privacy
boundaries: [extension guide](../docs/herdr-insights-extension.md).

The installer checks `mods/insights` before copying it to the app home, which
defaults to `$HERDR_APP_HOME` or `~/.config/herdr-app`. First install creates and
selects a personal layout whose **Insights** button sits beside the native tabs.
Reinstall updates owned files without rewriting layouts. Shipped tabs, keys, and
usage data are preserved.

Success requires one `herdr-app check passed` message **and exit code 0**.
Do not run developer tests or change tabs during installation. Open the dashboard
only if requested: click **Insights**, or add `-- --open` to the install command.

## Errors

Stop and report; do not force overwrites or rebuild to bypass errors. Preserve
local edits and any failed layout clone. Remove the app home's
`.insights-install.lock` directory only after confirming no installer/uninstaller is running.

Long scans are expected. Foreground refreshes are bounded and auto-continue;
giant zstd archives may finish in one managed local Node worker. Do not raise
Herdr's exec timeout. Lock/claim files fail closed: never delete a live or
foreign owner by age. Remove stale lock, `lock.acquire-*`, or quarantine
leftovers only after proving no writer is running and rechecking first.

Node.js **22.15+** is required. A partial save updates `savedAt`/`lastScanAt`,
not `lastCompletedScanAt`.
