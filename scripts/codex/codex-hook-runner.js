#!/usr/bin/env node
'use strict';

/**
 * Codex hook adapter for ECC's existing Node hook runtime.
 *
 * Codex executes commands from hooks.json directly. This runner keeps the
 * checked-in hook scripts shared with Claude Code by setting the same plugin
 * root environment variables and forwarding the raw hook JSON over stdin.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 300000;
const EMPTY_CODEX_HOOK_OUTPUT = '{}';
const MAX_REASON_CHARS = 4000;
const BLOCK_DECISION_EVENTS = new Set(['PostToolUse', 'Stop', 'UserPromptSubmit']);

function readStdinRaw() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_error) {
    return '';
  }
}

function writeStderr(message) {
  if (typeof message === 'string' && message.length > 0) {
    process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  }
}

function parseJsonObject(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isCodexHookResponse(value) {
  if (!isObject(value)) {
    return false;
  }

  if (isObject(value.hookSpecificOutput)) {
    return true;
  }

  // Codex also accepts generic hook control fields for events that do not
  // use hookSpecificOutput. Preserve those when a child hook emits them.
  return (
    hasOwn(value, 'continue') ||
    hasOwn(value, 'decision') ||
    hasOwn(value, 'reason') ||
    hasOwn(value, 'suppressOutput') ||
    hasOwn(value, 'stopReason')
  );
}

function getHookEventName(raw) {
  const parsed = parseJsonObject(raw);
  const eventName =
    parsed?.hook_event_name ||
    parsed?.hookEventName ||
    parsed?.hook?.eventName ||
    process.env.ECC_CODEX_HOOK_EVENT;

  return typeof eventName === 'string' ? eventName : '';
}

function normalizeCodexStdout(raw, stdout) {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
  if (!trimmed) {
    return null;
  }

  // Many Claude hooks signal "allow" by echoing the hook input. Codex expects
  // hook output, not the original event payload, so suppress that pass-through.
  if (raw.trim() && trimmed === raw.trim()) {
    return null;
  }

  const parsed = parseJsonObject(trimmed);
  if (isCodexHookResponse(parsed)) {
    return JSON.stringify(parsed);
  }

  return null;
}

function truncateReason(reason) {
  const normalized = String(reason || '').trim();
  if (normalized.length <= MAX_REASON_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_REASON_CHARS - 20)}... [truncated]`;
}

function failureReason(raw, result, fallback) {
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  const rawTrimmed = typeof raw === 'string' ? raw.trim() : '';
  const stdoutDetail = stdout && stdout !== rawTrimmed ? stdout : '';

  return truncateReason(stderr || stdoutDetail || fallback || '[Codex Hook] Hook blocked this tool call.');
}

function emitEmptyCodexOutput() {
  process.stdout.write(EMPTY_CODEX_HOOK_OUTPUT);
}

function emitPreToolUseDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function emitBlockDecision(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
  }));
}

function emitCodexOutput(raw, result) {
  const normalizedStdout = normalizeCodexStdout(raw, result?.stdout);
  if (normalizedStdout) {
    process.stdout.write(normalizedStdout);
    return;
  }

  const eventName = getHookEventName(raw);
  if (eventName === 'PreToolUse' && result?.status === 2) {
    emitPreToolUseDeny(failureReason(raw, result, '[Codex Hook] ECC hook blocked this tool call.'));
    return;
  }

  if (BLOCK_DECISION_EVENTS.has(eventName) && result?.status === 2) {
    emitBlockDecision(failureReason(raw, result, '[Codex Hook] ECC hook blocked this event.'));
    return;
  }

  emitEmptyCodexOutput();
}

function getRepoRoot() {
  const envRoot = process.env.ECC_CODEX_HOOK_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot && envRoot.trim()) {
    return path.resolve(envRoot.trim());
  }

  return path.resolve(__dirname, '..', '..');
}

function resolveInRoot(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, relPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }

  return resolved;
}

function buildChildArgs(rootDir, mode, args) {
  if (mode === 'script') {
    const [scriptRelPath, ...scriptArgs] = args;
    if (!scriptRelPath) {
      throw new Error('script mode requires a script path');
    }
    return [resolveInRoot(rootDir, scriptRelPath), ...scriptArgs];
  }

  if (mode === 'run-with-flags') {
    const [hookId, scriptRelPath, profilesCsv] = args;
    if (!hookId || !scriptRelPath) {
      throw new Error('run-with-flags mode requires a hook id and script path');
    }

    return [
      resolveInRoot(rootDir, 'scripts/hooks/run-with-flags.js'),
      hookId,
      scriptRelPath,
      ...(profilesCsv ? [profilesCsv] : []),
    ];
  }

  throw new Error(`unknown mode: ${mode || '(missing)'}`);
}

function main() {
  const raw = readStdinRaw();
  const [, , mode, ...args] = process.argv;
  const repoRoot = getRepoRoot();

  let childArgs;
  try {
    childArgs = buildChildArgs(repoRoot, mode, args);
  } catch (error) {
    writeStderr(`[Codex Hook] ${error.message}`);
    emitEmptyCodexOutput();
    process.exit(0);
  }

  if (!fs.existsSync(childArgs[0])) {
    writeStderr(`[Codex Hook] Script not found: ${childArgs[0]}`);
    emitEmptyCodexOutput();
    process.exit(0);
  }

  const result = spawnSync(process.execPath, childArgs, {
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      ECC_PLUGIN_ROOT: repoRoot,
      ECC_CODEX_HOOK_ROOT: repoRoot,
    },
    cwd: process.cwd(),
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });

  emitCodexOutput(raw, result);
  writeStderr(result.stderr);

  if (result.error || result.signal || result.status === null) {
    const reason = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : 'missing exit status';
    writeStderr(`[Codex Hook] Hook runner failed open: ${reason}`);
    process.exit(0);
  }

  const eventName = getHookEventName(raw);
  if (Number.isInteger(result.status) && result.status !== 0 && !(result.status === 2 && (eventName === 'PreToolUse' || BLOCK_DECISION_EVENTS.has(eventName)))) {
    writeStderr(`[Codex Hook] Hook exited with status ${result.status}; failed open after emitting Codex-safe output.`);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}
