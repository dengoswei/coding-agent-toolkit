import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PACKAGE_ROOT,
  RUNTIME_NAME,
  assertNoSymlinkComponents,
  assertSupportedNodeVersion,
  collectSourceFiles,
  createRuntimeFile,
  dataDir,
  ensureDirectory,
  expandHome,
  herdrFailure,
  lstatOrNull,
  localPath,
  manifestPath,
  modDir,
  readManifest,
  relayHerdrOutput,
  resolveAppHome,
  runHerdr,
  sha256,
  writeFileAtomic,
  writeManifest,
  withInstallerLock,
} from "./lib.mjs";

import { applyToolbar, prepareToolbar, installScreamControl } from "./toolbar.mjs";

function usage() {
  return `Insights local installer

Usage:
  npm run install:local -- [options]
  node scripts/install.mjs [options]

Options:
  --open                Open an Insights tab after installation (optional)
  --integrations        Enable connected-machine, Cursor account, and feedback statistics
  --force               Replace owned files edited locally (never unowned files or links)
  --source <folder>     Source package folder containing mods/insights (development)
  --app-home <folder>   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  -h, --help            Show this help

The installer copies mods/insights and creates a personal layout with an Insights
button beside the original tabs mod. It never edits shipped layouts/mods, keys,
terminals, or insights.json. It generates mods/insights/runtime.json with the
absolute Node executable used for installation. It does not publish or use the
network.
`;
}

function parseArgs(argv) {
  const options = {
    appHome: null,
    force: false,
    help: false,
    open: false,
    integrations: false,
    source: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--open") {
      options.open = true;
      continue;
    }
    if (argument === "--integrations") {
      options.integrations = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source needs a folder.");
      options.source = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--source=")) {
      const value = argument.slice("--source=".length);
      if (!value) throw new Error("--source needs a folder.");
      options.source = value;
      continue;
    }
    if (argument === "--app-home") {
      const value = argv[index + 1];
      if (!value) throw new Error("--app-home needs a folder.");
      options.appHome = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--app-home=")) {
      const value = argument.slice("--app-home=".length);
      if (!value) throw new Error("--app-home needs a folder.");
      options.appHome = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

async function addParentIssues(targetDirectory, target, issues) {
  const relative = path.relative(targetDirectory, target);
  const parts = relative.split(path.sep).slice(0, -1);
  let current = targetDirectory;

  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      issues.push(`Refusing a symbolic-link target directory: ${current}`);
      return;
    }
    if (!stat.isDirectory()) {
      issues.push(`A parent of a target file is not a directory: ${current}`);
      return;
    }
  }
}

async function collectInstallSource(sourceRoot) {
  const source = await collectSourceFiles(sourceRoot);
  source.files = source.files.filter((file) => file.relative !== RUNTIME_NAME);
  source.files.push(createRuntimeFile());
  source.files.sort((left, right) => left.relative.localeCompare(right.relative));
  return source;
}

async function prepareInstall(appHome, source, force) {
  const targetDirectory = modDir(appHome);
  const targetDataDirectory = dataDir(appHome);
  const targetManifest = manifestPath(appHome);

  if (path.resolve(source.modDir) === path.resolve(targetDirectory)) {
    throw new Error("Source and target are the same mod folder; refusing to install over itself.");
  }

  const targetStat = await lstatOrNull(targetDirectory);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic-link target: ${targetDirectory}`);
    }
    if (!targetStat.isDirectory()) {
      throw new Error(`Target mod path is not a directory: ${targetDirectory}`);
    }
  }

  const manifest = await readManifest(appHome);
  if (targetStat && !manifest) {
    throw new Error(
      `Refusing an unowned collision at ${targetDirectory}.\nNo ${targetManifest} proves this installer owns it. Move the folder aside or install with Herdr's own mod tools.`,
    );
  }

  const issues = [];
  const sourcePaths = new Set(source.files.map((file) => file.relative));

  for (const file of source.files) {
    const target = localPath(targetDirectory, file.relative);
    await addParentIssues(targetDirectory, target, issues);
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      issues.push(`Refusing to replace a symbolic link: ${target}`);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`Refusing to replace a non-regular file: ${target}`);
      continue;
    }

    const oldHash = manifest?.files[file.relative];
    if (!oldHash) {
      issues.push(`Unowned target file would be replaced: ${target}`);
      continue;
    }

    const currentHash = sha256(await fs.readFile(target));
    if (currentHash !== oldHash && currentHash !== file.hash && !force) {
      issues.push(
        `Owned file was edited locally: ${target} (use --force to replace it with reviewed source)`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Refusing to install; no target files were changed:\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
  }

  return { appHome, source, targetDirectory, targetDataDirectory, manifest, sourcePaths };
}

// Validate the exact buffered source (including runtime.json) before replacing
// the live mod.
async function checkInstallSource(source) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "insights-install-check-"));
  try {
    for (const file of source.files) {
      const target = localPath(modDir(staging), file.relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.data, { mode: file.mode });
    }
    const check = await runHerdr(["check", modDir(staging)], {
      env: { HERDR_APP_HOME: staging, HOME: staging },
    });
    relayHerdrOutput(check);
    if (check.error || check.code !== 0 || check.signal) {
      throw new Error(`${herdrFailure(check, "herdr-app check")}\nNo installed mod files were changed.`);
    }
    console.log("herdr-app check passed (insights, staged source).");
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function applyInstall(plan) {
  const { appHome, source, targetDirectory, targetDataDirectory, manifest, sourcePaths } = plan;
  await ensureDirectory(appHome, path.join(appHome, "mods"), "Herdr mods directory");
  await ensureDirectory(appHome, targetDirectory, "Insights mod directory");
  await ensureDirectory(appHome, targetDataDirectory, "Insights data directory", 0o700);

  const written = [];
  const unchanged = [];
  for (const file of source.files) {
    const target = localPath(targetDirectory, file.relative);
    await ensureDirectory(
      appHome,
      path.dirname(target),
      `Target directory for ${file.relative}`,
    );

    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing to replace a non-regular file: ${target}`);
      }
      if (sha256(await fs.readFile(target)) === file.hash) {
        unchanged.push(file.relative);
        continue;
      }
    }

    await writeFileAtomic(target, file.data, file.mode);
    written.push(file.relative);
  }

  const removed = [];
  const keptStale = [];
  const retainedHashes = Object.create(null);
  if (manifest) {
    for (const [relative, oldHash] of Object.entries(manifest.files)) {
      if (sourcePaths.has(relative)) continue;
      const target = localPath(targetDirectory, relative);
      try {
        await assertNoSymlinkComponents(appHome, target);
      } catch (error) {
        keptStale.push(`${target} (${error.message})`);
        retainedHashes[relative] = oldHash;
        continue;
      }
      const stat = await lstatOrNull(target);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        keptStale.push(`${target} (not a regular file)`);
        retainedHashes[relative] = oldHash;
        continue;
      }
      if (sha256(await fs.readFile(target)) !== oldHash) {
        keptStale.push(`${target} (edited locally)`);
        retainedHashes[relative] = oldHash;
        continue;
      }
      await fs.unlink(target);
      removed.push(relative);
    }
  }

  // Keep ownership proof for stale files we deliberately left in place.
  const installedHashes = {
    ...retainedHashes,
    ...Object.fromEntries(source.files.map((file) => [file.relative, file.hash])),
  };
  await writeManifest(appHome, installedHashes);

  console.log(
    `Installed ${source.files.length} owned file(s) to ${targetDirectory} ` +
      `(${written.length} written, ${unchanged.length} unchanged${
        removed.length ? `, ${removed.length} stale removed` : ""
      }).`,
  );
  console.log(`Generated ${RUNTIME_NAME} for Node ${process.execPath}.`);
  console.log(`Insights data stays at ${targetDataDirectory}; insights.json is untouched.`);
  for (const kept of keptStale) {
    console.warn(`Kept an owned file no longer in the source: ${kept}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    assertSupportedNodeVersion();
    const sourceRoot = options.source ? path.resolve(expandHome(options.source)) : PACKAGE_ROOT;
    // Validate the source before creating the app home. A bad --source must
    // not leave a new target directory behind.
    const source = await collectInstallSource(sourceRoot);
    const appHome = await resolveAppHome(options.appHome);
    await withInstallerLock(appHome, async () => {
      // Preflight every target before changing the live mod.
      let plan = await prepareInstall(appHome, source, options.force);
      const toolbar = await prepareToolbar(appHome);
      await checkInstallSource(source);
      // Native checks yield to the running app. Refuse edits/collisions made
      // during validation before replacing any live files.
      plan = await prepareInstall(appHome, plan.source, options.force);
      await applyInstall(plan);
      await applyToolbar(toolbar, { expand: options.integrations });
      if (options.integrations) {
        await installScreamControl(appHome);
        const integrations = path.join(dataDir(appHome), "integrations.json");
        await assertNoSymlinkComponents(appHome, integrations);
        await writeFileAtomic(integrations, `${JSON.stringify({ enabled: true })}\n`, 0o600);
        console.log("Enabled dynamic Herdr machines, Cursor account usage, and feedback statistics.");
      }
      // Default installation never opens a tab.
      if (options.open) {
        const opened = await runHerdr(["do", "tab.new", '{"name":"Insights","mod":"insights"}'], {
          env: { HERDR_APP_HOME: appHome },
        });
        relayHerdrOutput(opened);
        if (opened.error || opened.code !== 0 || opened.signal) {
          throw new Error(`${herdrFailure(opened, "Opening Insights")}\nFiles are installed; open the tab from the toolbar.`);
        }
        console.log("Opened the Insights tab.");
      }
    });
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
