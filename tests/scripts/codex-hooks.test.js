/**
 * Tests for Codex shell helpers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TOML = require('@iarna/toml');

const repoRoot = path.join(__dirname, '..', '..');
const installScript = path.join(repoRoot, 'scripts', 'codex', 'install-global-git-hooks.sh');
const codexHookRunnerScript = path.join(repoRoot, 'scripts', 'codex', 'codex-hook-runner.js');
const installCodexHooksScript = path.join(repoRoot, 'scripts', 'codex', 'install-codex-hooks.js');
const mergeCodexConfigScript = path.join(repoRoot, 'scripts', 'codex', 'merge-codex-config.js');
const mergeMcpConfigScript = path.join(repoRoot, 'scripts', 'codex', 'merge-mcp-config.js');
const syncScript = path.join(repoRoot, 'scripts', 'sync-ecc-to-codex.sh');
const deterministicPackageEnv = {
  CLAUDE_PACKAGE_MANAGER: 'npm',
  CLAUDE_CODE_PACKAGE_MANAGER: 'npm',
};

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizePathText(value) {
  return String(value).replace(/\\+/g, '/');
}

function runBash(scriptPath, args = [], env = {}, cwd = repoRoot) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runNode(scriptPath, args = [], env = {}, cwd = repoRoot, input = '') {
  return spawnSync('node', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function makeHermeticCodexEnv(homeDir, codexDir, extraEnv = {}) {
  const agentsHome = path.join(homeDir, '.agents');
  const hooksDir = path.join(codexDir, 'git-hooks');
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    GIT_CONFIG_GLOBAL: path.join(homeDir, '.gitconfig'),
    CODEX_HOME: codexDir,
    AGENTS_HOME: agentsHome,
    ECC_GLOBAL_HOOKS_DIR: hooksDir,
    CLAUDE_PACKAGE_MANAGER: 'npm',
    CLAUDE_CODE_PACKAGE_MANAGER: 'npm',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...extraEnv,
  };
}

let passed = 0;
let failed = 0;

// Windows NTFS does not allow double-quote characters in file paths,
// so the quoted-path shell-injection test is only meaningful on Unix.
if (os.platform() === 'win32') {
  console.log('  - install-global-git-hooks.sh quoted paths (skipped on Windows)');
} else if (
  test('install-global-git-hooks.sh handles quoted hook paths without shell injection', () => {
    const homeDir = createTempDir('codex-hooks-home-');
    const weirdHooksDir = path.join(homeDir, 'git-hooks "quoted"');

    try {
      const result = runBash(installScript, [], {
        HOME: homeDir,
        ECC_GLOBAL_HOOKS_DIR: weirdHooksDir,
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(weirdHooksDir, 'pre-commit')));
      assert.ok(fs.existsSync(path.join(weirdHooksDir, 'pre-push')));
    } finally {
      cleanup(homeDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('install-codex-hooks dry-run reports generated Codex hooks without mutating target', () => {
    const tempDir = createTempDir('codex-native-hooks-dry-run-');
    const hooksPath = path.join(tempDir, 'hooks.json');

    try {
      const result = runNode(installCodexHooksScript, [
        hooksPath,
        '--dry-run',
        '--command-root',
        '/tmp/ecc root',
      ]);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /\[dry-run\]/);
      assert.match(result.stdout, /Codex hooks events:/);
      assert.match(result.stdout, /PreToolUse/);
      assert.match(result.stdout, /PostToolUse/);
      assert.ok(!fs.existsSync(hooksPath), 'dry-run must not write hooks.json');
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('install-codex-hooks writes supported events with Codex runner commands', () => {
    const tempDir = createTempDir('codex-native-hooks-install-');
    const hooksPath = path.join(tempDir, 'hooks.json');

    try {
      const result = runNode(installCodexHooksScript, [
        hooksPath,
        '--command-root',
        '/tmp/ecc root',
      ]);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Installed Codex hooks/);

      const installed = readJson(hooksPath);
      assert.ok(installed.hooks, 'Expected top-level hooks object');
      assert.ok(Array.isArray(installed.hooks.PreToolUse));
      assert.ok(Array.isArray(installed.hooks.PostToolUse));
      assert.ok(Array.isArray(installed.hooks.Stop));
      assert.ok(Array.isArray(installed.hooks.SessionStart));
      assert.ok(!installed.hooks.PreCompact, 'Codex does not currently support PreCompact');
      assert.ok(!installed.hooks.PostCompact, 'Codex does not currently support PostCompact');
      assert.ok(!installed.hooks.PostToolUseFailure, 'Codex does not support PostToolUseFailure');
      assert.ok(!installed.hooks.SessionEnd, 'Codex does not support SessionEnd');

      const serialized = normalizePathText(JSON.stringify(installed, null, 2));
      assert.match(serialized, /scripts\/codex\/codex-hook-runner\.js/);
      assert.match(serialized, /scripts\/hooks\/pre-bash-dispatcher\.js/);
      assert.doesNotMatch(serialized, /\.claude/);
      assert.doesNotMatch(serialized, /CLAUDE_PLUGIN_ROOT/);
      assert.doesNotMatch(serialized, /"async"/);

      for (const groups of Object.values(installed.hooks)) {
        for (const group of groups) {
          assert.ok(!('id' in group), 'Codex hook groups should not carry Claude-only ids');
          assert.ok(!('description' in group), 'Codex hook groups should not carry Claude-only descriptions');
          for (const hook of group.hooks) {
            assert.strictEqual(hook.type, 'command');
            assert.strictEqual(typeof hook.command, 'string');
          }
        }
      }
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('install-codex-hooks preserves custom hooks and is idempotent for ECC hooks', () => {
    const tempDir = createTempDir('codex-native-hooks-idempotent-');
    const hooksPath = path.join(tempDir, 'hooks.json');
    const customHooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo custom-pre-bash' }],
          },
        ],
      },
    };

    try {
      fs.writeFileSync(hooksPath, JSON.stringify(customHooks, null, 2));

      const first = runNode(installCodexHooksScript, [hooksPath, '--command-root', '/tmp/ecc root']);
      assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
      const afterFirst = readJson(hooksPath);
      const firstSerialized = normalizePathText(JSON.stringify(afterFirst));
      assert.match(firstSerialized, /echo custom-pre-bash/);

      const firstRunnerCommands = firstSerialized.match(/codex-hook-runner\.js/g) || [];
      assert.ok(firstRunnerCommands.length > 0, 'Expected ECC runner commands');

      const second = runNode(installCodexHooksScript, [hooksPath, '--command-root', '/tmp/ecc root']);
      assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
      const afterSecond = readJson(hooksPath);
      const secondSerialized = normalizePathText(JSON.stringify(afterSecond));
      const secondRunnerCommands = secondSerialized.match(/codex-hook-runner\.js/g) || [];

      assert.match(secondSerialized, /echo custom-pre-bash/);
      assert.strictEqual(secondRunnerCommands.length, firstRunnerCommands.length);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('normalizePathText collapses JSON-escaped Windows path separators', () => {
    const serialized = JSON.stringify({
      command: 'node "C:\\ecc root\\scripts\\codex\\codex-hook-runner.js"',
    });

    assert.match(
      normalizePathText(serialized),
      /scripts\/codex\/codex-hook-runner\.js/
    );
  })
)
  passed++;
else failed++;

if (
  test('install-codex-hooks treats shell-quoted Windows runner commands as managed', () => {
    const { mergeHooks } = require(installCodexHooksScript);
    const generatedGroup = {
      hooks: [
        {
          type: 'command',
          command: 'node "scripts/codex/codex-hook-runner.js" script "scripts/hooks/new.js"',
        },
      ],
    };
    const existing = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node "C:\\\\ecc root\\\\scripts\\\\codex\\\\codex-hook-runner.js" script "scripts/hooks/old.js"',
              },
            ],
          },
        ],
      },
    };

    const merged = mergeHooks(existing, { PreToolUse: [generatedGroup] });

    assert.deepStrictEqual(merged.hooks.PreToolUse, [generatedGroup]);
  })
)
  passed++;
else failed++;

if (
  test('codex-hook-runner suppresses Claude pass-through stdout and emits valid Codex JSON', () => {
    const tempDir = createTempDir('codex-runner-pass-through-');
    const hookDir = path.join(tempDir, 'scripts', 'hooks');
    const hookInput = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
    });

    try {
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'pass-through.js'),
        "process.stdin.pipe(process.stdout);\n",
        'utf8'
      );

      const result = runNode(
        codexHookRunnerScript,
        ['script', 'scripts/hooks/pass-through.js'],
        { ECC_CODEX_HOOK_ROOT: tempDir },
        repoRoot,
        hookInput
      );

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepStrictEqual(JSON.parse(result.stdout), {});
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('codex-hook-runner preserves hookSpecificOutput responses from Codex-aware hooks', () => {
    const tempDir = createTempDir('codex-runner-preserve-output-');
    const hookDir = path.join(tempDir, 'scripts', 'hooks');
    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'codex context',
      },
    };

    try {
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'codex-output.js'),
        `process.stdout.write(${JSON.stringify(JSON.stringify(hookOutput))});\n`,
        'utf8'
      );

      const result = runNode(
        codexHookRunnerScript,
        ['script', 'scripts/hooks/codex-output.js'],
        { ECC_CODEX_HOOK_ROOT: tempDir },
        repoRoot,
        JSON.stringify({ hook_event_name: 'SessionStart' })
      );

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepStrictEqual(JSON.parse(result.stdout), hookOutput);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('codex-hook-runner maps Claude exit code 2 to Codex PreToolUse denial JSON', () => {
    const tempDir = createTempDir('codex-runner-pretool-deny-');
    const hookDir = path.join(tempDir, 'scripts', 'hooks');

    try {
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'block.js'),
        "process.stderr.write('blocked by legacy hook\\n');\nprocess.exit(2);\n",
        'utf8'
      );

      const result = runNode(
        codexHookRunnerScript,
        ['script', 'scripts/hooks/block.js'],
        { ECC_CODEX_HOOK_ROOT: tempDir },
        repoRoot,
        JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })
      );

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /blocked by legacy hook/);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('codex-hook-runner maps Claude exit code 2 to Codex block decisions for Stop-style events', () => {
    const tempDir = createTempDir('codex-runner-stop-block-');
    const hookDir = path.join(tempDir, 'scripts', 'hooks');

    try {
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'block-stop.js'),
        "process.stderr.write('stop feedback from legacy hook\\n');\nprocess.exit(2);\n",
        'utf8'
      );

      const result = runNode(
        codexHookRunnerScript,
        ['script', 'scripts/hooks/block-stop.js'],
        { ECC_CODEX_HOOK_ROOT: tempDir },
        repoRoot,
        JSON.stringify({ hook_event_name: 'Stop' })
      );

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.decision, 'block');
      assert.match(output.reason, /stop feedback from legacy hook/);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-codex-config reports usage, missing files, and TOML parse failures', () => {
    const tempDir = createTempDir('codex-merge-errors-');

    try {
      const noArgs = runNode(mergeCodexConfigScript);
      assert.strictEqual(noArgs.status, 1);
      assert.match(noArgs.stderr, /Usage: merge-codex-config\.js/);

      const missingPath = path.join(tempDir, 'missing-config.toml');
      const missing = runNode(mergeCodexConfigScript, [missingPath]);
      assert.strictEqual(missing.status, 1);
      assert.match(missing.stderr, /Config file not found/);

      const invalidPath = path.join(tempDir, 'invalid-config.toml');
      fs.writeFileSync(invalidPath, 'approval_policy = [\n');
      const invalid = runNode(mergeCodexConfigScript, [invalidPath]);
      assert.strictEqual(invalid.status, 1);
      assert.match(invalid.stderr, /Failed to parse TOML/);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-codex-config dry-run reports additions without mutating the target', () => {
    const tempDir = createTempDir('codex-merge-dry-run-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = '';

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeCodexConfigScript, [configPath, '--dry-run']);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /\[add-root\]/);
      assert.match(result.stdout, /\[add-table\] \[features\]/);
      assert.match(result.stdout, /Dry run/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-codex-config preserves user root choices while adding missing baseline tables', () => {
    const tempDir = createTempDir('codex-merge-add-only-');
    const configPath = path.join(tempDir, 'config.toml');

    try {
      fs.writeFileSync(configPath, 'approval_policy = "never"\n');
      const result = runNode(mergeCodexConfigScript, [configPath]);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Done\. Baseline Codex settings merged\./);

      const merged = fs.readFileSync(configPath, 'utf8');
      const parsed = TOML.parse(merged);
      assert.strictEqual(parsed.approval_policy, 'never');
      assert.strictEqual(parsed.sandbox_mode, 'workspace-write');
      assert.strictEqual(parsed.web_search, 'live');
      assert.strictEqual(parsed.features.multi_agent, true);
      assert.strictEqual(parsed.profiles.strict.approval_policy, 'on-request');
      assert.strictEqual(parsed.profiles.yolo.approval_policy, 'never');
      assert.strictEqual(parsed.agents.max_threads, 6);
      assert.strictEqual(parsed.agents.explorer.config_file, 'agents/explorer.toml');
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-codex-config no-ops when the Codex baseline is already present', () => {
    const tempDir = createTempDir('codex-merge-noop-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = fs.readFileSync(path.join(repoRoot, '.codex', 'config.toml'), 'utf8');

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeCodexConfigScript, [configPath]);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /All baseline Codex settings already present/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-codex-config warns when inline tables cannot be safely extended', () => {
    const tempDir = createTempDir('codex-merge-inline-warn-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = 'agents = { explorer = { description = "custom explorer" } }\n';

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeCodexConfigScript, [configPath, '--dry-run']);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /WARNING: Skipping missing keys/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-mcp-config reports usage, missing files, and TOML parse failures', () => {
    const tempDir = createTempDir('mcp-merge-errors-');

    try {
      const noArgs = runNode(mergeMcpConfigScript, [], deterministicPackageEnv);
      assert.strictEqual(noArgs.status, 1);
      assert.match(noArgs.stderr, /Usage: merge-mcp-config\.js/);

      const missingPath = path.join(tempDir, 'missing-config.toml');
      const missing = runNode(mergeMcpConfigScript, [missingPath], deterministicPackageEnv);
      assert.strictEqual(missing.status, 1);
      assert.match(missing.stderr, /Config file not found/);

      const invalidPath = path.join(tempDir, 'invalid-config.toml');
      fs.writeFileSync(invalidPath, '[mcp_servers.github\n');
      const invalid = runNode(mergeMcpConfigScript, [invalidPath], deterministicPackageEnv);
      assert.strictEqual(invalid.status, 1);
      assert.match(invalid.stderr, /Failed to parse/);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-mcp-config dry-run appends all recommended servers without mutating target', () => {
    const tempDir = createTempDir('mcp-merge-dry-run-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = '';

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeMcpConfigScript, [configPath, '--dry-run'], deterministicPackageEnv);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Package manager: npm \(exec: npx\)/);
      assert.match(result.stdout, /\[add\] mcp_servers\.supabase/);
      assert.match(result.stdout, /\[mcp_servers\.github\]/);
      assert.match(result.stdout, /Dry run/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-mcp-config no-ops after all recommended servers are present', () => {
    const tempDir = createTempDir('mcp-merge-noop-');
    const configPath = path.join(tempDir, 'config.toml');

    try {
      fs.writeFileSync(configPath, '');
      const first = runNode(mergeMcpConfigScript, [configPath], deterministicPackageEnv);
      assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);

      const merged = fs.readFileSync(configPath, 'utf8');
      const parsed = TOML.parse(merged);
      assert.strictEqual(parsed.mcp_servers.exa.url, 'https://mcp.exa.ai/mcp');
      assert.strictEqual(parsed.mcp_servers.github.command, 'bash');
      assert.deepStrictEqual(parsed.mcp_servers.memory.args, ['@modelcontextprotocol/server-memory']);
      assert.strictEqual(parsed.mcp_servers.supabase.tool_timeout_sec, 120);

      const second = runNode(mergeMcpConfigScript, [configPath], deterministicPackageEnv);
      assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.match(second.stdout, /\[ok\] mcp_servers\.github/);
      assert.match(second.stdout, /All ECC MCP servers already present/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), merged);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-mcp-config update dry-run reports canonical and legacy section refreshes', () => {
    const tempDir = createTempDir('mcp-merge-update-dry-run-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = [
      '[mcp_servers.context7]',
      'command = "custom"',
      'args = ["old"]',
      '',
      '[mcp_servers.context7-mcp]',
      'command = "npx"',
      'args = ["legacy"]',
      '',
      '[mcp_servers.supabase]',
      'command = "custom"',
      'args = ["old"]',
      '',
      '[mcp_servers.supabase.env]',
      'SUPABASE_ACCESS_TOKEN = "token"',
      '',
    ].join('\n');

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeMcpConfigScript, [configPath, '--update-mcp', '--dry-run'], deterministicPackageEnv);

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /\[remove\] mcp_servers\.context7/);
      assert.match(result.stdout, /\[remove\] mcp_servers\.context7-mcp/);
      assert.match(result.stdout, /\[remove\] mcp_servers\.supabase/);
      assert.match(result.stdout, /\[mcp_servers\.supabase\]/);
      assert.match(result.stdout, /\[mcp_servers\.context7\]/);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('merge-mcp-config removes disabled legacy servers without appending replacements', () => {
    const tempDir = createTempDir('mcp-merge-disabled-');
    const configPath = path.join(tempDir, 'config.toml');
    const original = [
      '[mcp_servers.context7-mcp]',
      'command = "npx"',
      'args = ["legacy"]',
      '',
      '[mcp_servers.exa]',
      'url = "https://mcp.exa.ai/mcp"',
      '',
    ].join('\n');
    const allServersDisabled = 'supabase,playwright,context7,exa,github,memory,sequential-thinking';

    try {
      fs.writeFileSync(configPath, original);
      const result = runNode(mergeMcpConfigScript, [configPath], {
        ...deterministicPackageEnv,
        ECC_DISABLED_MCPS: allServersDisabled,
      });

      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Disabled via ECC_DISABLED_MCPS/);
      assert.match(result.stdout, /\[skip\] mcp_servers\.context7 \(disabled\)/);
      assert.match(result.stdout, /\[skip\] mcp_servers\.exa \(disabled\)/);
      assert.match(result.stdout, /\[update\] mcp_servers\.context7-mcp \(disabled\)/);
      assert.match(result.stdout, /\[update\] mcp_servers\.exa \(disabled\)/);
      assert.match(result.stdout, /Done\. Removed 2 disabled server\(s\)\./);

      const updated = fs.readFileSync(configPath, 'utf8');
      assert.doesNotMatch(updated, /context7-mcp/);
      assert.doesNotMatch(updated, /mcp_servers\.exa/);
    } finally {
      cleanup(tempDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('sync installs the missing Codex baseline and accepts the legacy context7 MCP section', () => {
    const homeDir = createTempDir('codex-sync-home-');
    const codexDir = path.join(homeDir, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const agentsPath = path.join(codexDir, 'AGENTS.md');
    const config = [
      'persistent_instructions = ""',
      '',
      '[agents]',
      'explorer = { description = "Read-only codebase explorer for gathering evidence before changes are proposed." }',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      '',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      '',
      '[mcp_servers.memory]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-memory"]',
      '',
      '[mcp_servers.sequential-thinking]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
      '',
    ].join('\n');

    try {
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(configPath, config);

      const syncResult = runBash(syncScript, ['--update-mcp'], makeHermeticCodexEnv(homeDir, codexDir));
      assert.strictEqual(syncResult.status, 0, `${syncResult.stdout}\n${syncResult.stderr}`);

      const syncedAgents = fs.readFileSync(agentsPath, 'utf8');
      assert.match(syncedAgents, /^# Everything Claude Code \(ECC\) — Agent Instructions/m);
      assert.match(syncedAgents, /^# Codex Supplement \(From ECC \.codex\/AGENTS\.md\)/m);

      const syncedConfig = fs.readFileSync(configPath, 'utf8');
      const parsedConfig = TOML.parse(syncedConfig);
      assert.strictEqual(parsedConfig.approval_policy, 'on-request');
      assert.strictEqual(parsedConfig.sandbox_mode, 'workspace-write');
      assert.strictEqual(parsedConfig.web_search, 'live');
      assert.ok(!Object.prototype.hasOwnProperty.call(parsedConfig, 'multi_agent'));
      assert.ok(parsedConfig.features);
      assert.strictEqual(parsedConfig.features.codex_hooks, true);
      assert.strictEqual(parsedConfig.features.hooks, true);
      assert.strictEqual(parsedConfig.features.multi_agent, true);
      assert.ok(parsedConfig.profiles);
      assert.strictEqual(parsedConfig.profiles.strict.approval_policy, 'on-request');
      assert.strictEqual(parsedConfig.profiles.yolo.approval_policy, 'never');
      assert.ok(parsedConfig.agents);
      assert.strictEqual(parsedConfig.agents.max_threads, 6);
      assert.strictEqual(parsedConfig.agents.max_depth, 1);
      assert.strictEqual(parsedConfig.agents.explorer.config_file, 'agents/explorer.toml');
      assert.strictEqual(parsedConfig.agents.reviewer.config_file, 'agents/reviewer.toml');
      assert.strictEqual(parsedConfig.agents.docs_researcher.config_file, 'agents/docs-researcher.toml');
      assert.ok(parsedConfig.mcp_servers.exa);
      assert.ok(parsedConfig.mcp_servers.github);
      assert.ok(parsedConfig.mcp_servers.memory);
      assert.ok(parsedConfig.mcp_servers['sequential-thinking']);
      assert.ok(parsedConfig.mcp_servers.context7);

      for (const roleFile of ['explorer.toml', 'reviewer.toml', 'docs-researcher.toml']) {
        assert.ok(fs.existsSync(path.join(codexDir, 'agents', roleFile)));
      }

      const syncedHooks = readJson(path.join(codexDir, 'hooks.json'));
      assert.ok(Array.isArray(syncedHooks.hooks.PreToolUse));
      assert.ok(Array.isArray(syncedHooks.hooks.PostToolUse));
      const syncedHooksText = normalizePathText(JSON.stringify(syncedHooks));
      assert.match(syncedHooksText, /scripts\/codex\/codex-hook-runner\.js/);
      assert.doesNotMatch(syncedHooksText, /\.claude/);
    } finally {
      cleanup(homeDir);
    }
  })
)
  passed++;
else failed++;

if (
  test('sync adds parent-table keys when the target only declares an implicit parent table', () => {
    const homeDir = createTempDir('codex-sync-implicit-parent-home-');
    const codexDir = path.join(homeDir, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const config = [
      'persistent_instructions = ""',
      '',
      '[agents.explorer]',
      'description = "Read-only codebase explorer for gathering evidence before changes are proposed."',
      '',
    ].join('\n');

    try {
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(configPath, config);

      const syncResult = runBash(syncScript, [], makeHermeticCodexEnv(homeDir, codexDir));
      assert.strictEqual(syncResult.status, 0, `${syncResult.stdout}\n${syncResult.stderr}`);

      const parsedConfig = TOML.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(parsedConfig.agents.max_threads, 6);
      assert.strictEqual(parsedConfig.agents.max_depth, 1);
      assert.strictEqual(parsedConfig.agents.explorer.config_file, 'agents/explorer.toml');
    } finally {
      cleanup(homeDir);
    }
  })
)
  passed++;
else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
