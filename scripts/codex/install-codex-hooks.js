#!/usr/bin/env node
'use strict';

/**
 * Generate Codex-native hooks.json from ECC's canonical hooks/hooks.json.
 *
 * The canonical file is Claude/plugin oriented and contains Claude-specific
 * root-discovery snippets plus events that Codex does not currently support.
 * This installer keeps user-defined Codex hooks, replaces prior ECC-managed
 * groups idempotently, and writes a Codex-compatible hooks.json.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultSourcePath = path.join(repoRoot, 'hooks', 'hooks.json');
const supportedCodexEvents = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
]);
const managedCommandMarker = /scripts[\\/]+codex[\\/]+codex-hook-runner\.js/;

function usage() {
  console.error('Usage: install-codex-hooks.js <dest-hooks.json> [--dry-run] [--source <hooks.json>] [--command-root <path>]');
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    destPath: null,
    sourcePath: defaultSourcePath,
    commandRoot: repoRoot,
    dryRun: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--source') {
      options.sourcePath = args.shift();
    } else if (arg === '--command-root') {
      options.commandRoot = args.shift();
    } else if (arg && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.destPath) {
      options.destPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.destPath) {
    throw new Error('Missing destination hooks.json path');
  }

  if (!options.sourcePath) {
    throw new Error('Missing --source value');
  }

  if (!options.commandRoot) {
    throw new Error('Missing --command-root value');
  }

  return options;
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}

function quoteShellArg(value) {
  return JSON.stringify(String(value));
}

function resolveRunnerPath(commandRoot) {
  return path.join(commandRoot, 'scripts', 'codex', 'codex-hook-runner.js');
}

function buildRunnerCommand(commandRoot, mode, args) {
  return [
    'node',
    quoteShellArg(resolveRunnerPath(commandRoot)),
    mode,
    ...args.map(quoteShellArg),
  ].join(' ');
}

function extractHookInvocation(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return null;
  }

  const stopMatch = command.match(/spawnSync\(process\.execPath,\[script,'([^']+)','([^']+)','([^']+)'/);
  if (stopMatch) {
    return {
      mode: 'run-with-flags',
      args: [stopMatch[1], stopMatch[2], stopMatch[3]],
    };
  }

  const flagsMatch = command.match(/run-with-flags\.js\s+([^\s'"]+)\s+([^\s'"]+)(?:\s+([^\s'"]+))?/);
  if (flagsMatch) {
    return {
      mode: 'run-with-flags',
      args: [flagsMatch[1], flagsMatch[2], flagsMatch[3]].filter(Boolean),
    };
  }

  const directMatch = command.match(/node\s+(scripts\/hooks\/[\w.-]+\.js)/);
  if (directMatch) {
    return {
      mode: 'script',
      args: [directMatch[1]],
    };
  }

  return null;
}

function convertHookItem(item, commandRoot) {
  if (!item || typeof item !== 'object' || item.type !== 'command') {
    return null;
  }

  const invocation = extractHookInvocation(item.command);
  if (!invocation) {
    return null;
  }

  const converted = {
    type: 'command',
    command: buildRunnerCommand(commandRoot, invocation.mode, invocation.args),
  };

  if (typeof item.timeout === 'number' && Number.isFinite(item.timeout) && item.timeout > 0) {
    converted.timeout = item.timeout;
  }

  return converted;
}

function convertGroup(group, commandRoot) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
    return null;
  }

  const hooks = group.hooks
    .map(item => convertHookItem(item, commandRoot))
    .filter(Boolean);

  if (hooks.length === 0) {
    return null;
  }

  const converted = { hooks };
  if (Object.prototype.hasOwnProperty.call(group, 'matcher')) {
    converted.matcher = group.matcher;
  }

  return converted;
}

function buildCodexHooks(source, commandRoot) {
  const hooks = source.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error('Source hooks.json must contain a top-level hooks object');
  }

  const converted = {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!supportedCodexEvents.has(eventName) || !Array.isArray(groups)) {
      continue;
    }

    const convertedGroups = groups
      .map(group => convertGroup(group, commandRoot))
      .filter(Boolean);

    if (convertedGroups.length > 0) {
      converted[eventName] = convertedGroups;
    }
  }

  return converted;
}

function isManagedGroup(group) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.length === 0) {
    return false;
  }

  return group.hooks.every(hook => {
    const command = hook && typeof hook.command === 'string' ? hook.command : '';
    return managedCommandMarker.test(command);
  });
}

function loadExistingHooks(destPath) {
  if (!fs.existsSync(destPath)) {
    return { hooks: {} };
  }

  const existing = readJsonObject(destPath, 'existing Codex hooks.json');
  if (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)) {
    existing.hooks = {};
  }

  return existing;
}

function mergeHooks(existing, generatedHooks) {
  const merged = {
    ...existing,
    hooks: {},
  };

  const eventNames = new Set([
    ...Object.keys(existing.hooks || {}),
    ...Object.keys(generatedHooks),
  ]);

  for (const eventName of eventNames) {
    const currentGroups = Array.isArray(existing.hooks[eventName])
      ? existing.hooks[eventName].filter(group => !isManagedGroup(group))
      : [];
    const nextGroups = generatedHooks[eventName] || [];
    const groups = [...currentGroups, ...nextGroups];
    if (groups.length > 0) {
      merged.hooks[eventName] = groups;
    }
  }

  return merged;
}

function summarizeHooks(hooks) {
  return Object.entries(hooks)
    .map(([eventName, groups]) => `${eventName}=${groups.length}`)
    .join(', ');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(`[ecc-codex-hooks] ${error.message}`);
    process.exit(1);
  }

  const source = readJsonObject(options.sourcePath, 'source hooks.json');
  const existing = loadExistingHooks(options.destPath);
  const generatedHooks = buildCodexHooks(source, options.commandRoot);
  const merged = mergeHooks(existing, generatedHooks);
  const output = `${JSON.stringify(merged, null, 2)}\n`;

  if (options.dryRun) {
    console.log(`[ecc-codex-hooks] [dry-run] Would write ${options.destPath}`);
    console.log(`[ecc-codex-hooks] Codex hooks events: ${summarizeHooks(generatedHooks)}`);
    return;
  }

  fs.mkdirSync(path.dirname(options.destPath), { recursive: true });
  fs.writeFileSync(options.destPath, output);
  console.log(`[ecc-codex-hooks] Installed Codex hooks: ${options.destPath}`);
  console.log(`[ecc-codex-hooks] Codex hooks events: ${summarizeHooks(generatedHooks)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ecc-codex-hooks] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildCodexHooks,
  extractHookInvocation,
  mergeHooks,
};
