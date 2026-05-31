/**
 * cli.ts upgrade() — CC-only block gating (PR #720 follow-up).
 *
 * Two distinct platform gates run inside upgrade():
 *
 *   1. isCC = CC_PLUGIN_SYSTEM_PLATFORMS.has(platform)  → {claude-code}
 *      Wraps Claude Code's plugin-system artifacts: marketplace clone sync
 *      (refs 7c159c2 / #418), .claude-plugin/plugin.json drift heal
 *      (refs 8c65c3d / #523), installed_plugins.json registry assertion
 *      (v1.0.114 hotfix), .mcp.json sweep (refs 666b556 / #531),
 *      ~/.claude.json user-MCP heal (refs 7f1e1e8 / #579), and
 *      installed_plugins.json-driven skills sync (#228).
 *
 *      These artifacts ONLY exist for Claude Code. Pi, codex, gemini-cli,
 *      cursor, kiro, omp, zed, vscode-copilot, jetbrains-copilot,
 *      antigravity, qwen-code, opencode, kilo all touch zero of them —
 *      running these blocks on those platforms corrupts ~/.claude/.
 *
 *   2. !isInProcessPluginPlatform(platform) → exclude {opencode, kilo}
 *      Wraps the better-sqlite3 ABI verifier, binding self-heal, and
 *      `npm install -g` step. opencode/kilo ride the host's MCP loader
 *      in-process (refs 3e51e53 / #650) so they have no separate binary
 *      to install and the host owns better-sqlite3. Every other adapter
 *      (including pi, codex, gemini-cli, etc.) runs the MCP server
 *      out-of-process and DOES need its better-sqlite3 binding healed
 *      after npm install — refs 5b6ef81 / #514 added the loud-fail
 *      binding verifier specifically because silent ABI breakage on
 *      Node 26 left /ctx-upgrade reporting success while the knowledge
 *      base was unusable. Gating ABI on isCC re-opens that exact
 *      regression class on 11 of 14 adapters.
 *
 * These tests lock the polarity by source-grep, the same shape as
 * tests/util/cli-upgrade-verification.test.ts (which already asserts the
 * pre-#720 gate position for npm-global).
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
const upgradeIdx = cliSrc.indexOf("async function upgrade");
// Mirror tests/util/cli-upgrade-verification.test.ts:50 — 30 000 chars
// safely contains the full upgrade() body with growth headroom.
const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 30000);

describe("PR #720 — CC-only blocks are gated by isCC", () => {
  test("CC_PLUGIN_SYSTEM_PLATFORMS contains only claude-code (claude-code is the only platform with the marketplace + installed_plugins.json + .claude.json + skills-registry artifacts)", () => {
    // The set is what defines isCC. If we widen it to non-CC platforms,
    // those platforms will trigger marketplace sync / installed_plugins
    // assertion / .mcp.json sweep — all of which resolve to ~/.claude/
    // and corrupt non-CC user state.
    expect(cliSrc).toMatch(
      /const\s+CC_PLUGIN_SYSTEM_PLATFORMS\s*=\s*new\s+Set\(\s*\[\s*["']claude-code["']\s*\]\s*\)/,
    );
  });

  test("marketplace clone sync is wrapped by isCC (platform=pi/gemini-cli skip, platform=claude-code runs) — protects #418 fix from leaking ~/.claude/plugins/marketplaces/ writes onto non-CC platforms", () => {
    // The marketplace block must sit AFTER an `if (isCC)` gate and BEFORE
    // its closing brace. Pre-PR #720 this block ran for every platform
    // and resolved marketplaceDir via resolveClaudeConfigDir() →
    // ~/.claude/plugins/marketplaces/context-mode/, polluting Pi/OMP/etc.
    const marketplaceMsg = upgradeBody.indexOf("Syncing marketplace clone");
    const isCCGate = upgradeBody.lastIndexOf("if (isCC)", marketplaceMsg);
    expect(marketplaceMsg).toBeGreaterThan(0);
    expect(isCCGate).toBeGreaterThan(0);
    expect(isCCGate).toBeLessThan(marketplaceMsg);

    // First CC-block closing brace must appear AFTER the marketplace sync.
    const closeIdx = upgradeBody.indexOf("} // CC_PLUGIN_SYSTEM_PLATFORMS", marketplaceMsg);
    expect(closeIdx).toBeGreaterThan(marketplaceMsg);
  });

  test("installed_plugins.json registry assertion + plugin.json drift heal + .mcp.json sweep + ~/.claude.json heal sit inside an isCC gate — these touch CC-only artifacts and would corrupt ~/.claude/ on Pi/codex/gemini-cli/cursor/kiro/omp/zed/vscode-copilot/jetbrains-copilot/antigravity/qwen-code/opencode/kilo (13 of 14 adapters)", () => {
    const registryCheck = upgradeBody.indexOf("Registry consistency check");
    const pluginJsonHeal = upgradeBody.indexOf("plugin.json drift check failed");
    const mcpJsonSweep = upgradeBody.indexOf(".mcp.json sweep check failed");
    const claudeJsonHeal = upgradeBody.indexOf("healClaudeJsonMcpArgs");

    // All four blocks must exist…
    expect(registryCheck).toBeGreaterThan(0);
    expect(pluginJsonHeal).toBeGreaterThan(0);
    expect(mcpJsonSweep).toBeGreaterThan(0);
    expect(claudeJsonHeal).toBeGreaterThan(0);

    // …and all four must sit inside the same isCC gate (after an `if (isCC)`
    // and before the next `} // CC_PLUGIN_SYSTEM_PLATFORMS` marker).
    for (const idx of [registryCheck, pluginJsonHeal, mcpJsonSweep, claudeJsonHeal]) {
      const gate = upgradeBody.lastIndexOf("if (isCC)", idx);
      const close = upgradeBody.indexOf("} // CC_PLUGIN_SYSTEM_PLATFORMS", idx);
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(idx);
      expect(close).toBeGreaterThan(idx);
    }
  });

  test("better-sqlite3 ABI verifier + binding self-heal + npm-global install REMAIN gated by !isInProcessPluginPlatform (NOT by isCC) — protects #514 ABI regression class from re-opening on platform=pi/codex/gemini-cli/cursor/kiro/omp/zed/vscode-copilot/jetbrains-copilot/antigravity/qwen-code (11 of 14 adapters)", () => {
    // 5b6ef81 (#514) added the binding verifier because Node 26 +
    // optionalDependencies silently dropped better-sqlite3 and
    // /ctx-upgrade reported success on a poisoned tree. Gating this
    // block on isCC instead of !isInProcessPluginPlatform makes the
    // verifier silently skip on every non-CC out-of-process adapter,
    // exactly the failure mode #514 fixed.
    const abiVerifier = upgradeBody.indexOf("Verifying native addon ABI");
    const bindingHealMsg = upgradeBody.indexOf("better-sqlite3 native binding: MISSING");
    const npmGlobal = upgradeBody.indexOf('"install", "-g"');

    expect(abiVerifier).toBeGreaterThan(0);
    expect(bindingHealMsg).toBeGreaterThan(0);
    expect(npmGlobal).toBeGreaterThan(0);

    // All three must sit inside the !isInProcessPluginPlatform block,
    // NOT inside an isCC block.
    const inProcGate = upgradeBody.lastIndexOf(
      "!isInProcessPluginPlatform(detection.platform)",
      abiVerifier,
    );
    expect(inProcGate).toBeGreaterThan(0);
    expect(inProcGate).toBeLessThan(abiVerifier);
    expect(inProcGate).toBeLessThan(bindingHealMsg);
    expect(inProcGate).toBeLessThan(npmGlobal);

    // Defense in depth: between the gate and the ABI verifier there
    // must be NO intervening `if (isCC)` (which would re-introduce the
    // PR #720 polarity bug — verifier inside isCC inside !inProc).
    const sliceBetween = upgradeBody.slice(inProcGate, abiVerifier);
    expect(sliceBetween).not.toMatch(/if\s*\(\s*isCC\s*\)\s*\{/);
  });

  test("skills sync via installed_plugins.json registry is wrapped by isCC — registry-driven sync only makes sense when the installed_plugins.json registry exists (claude-code only); other adapters write skills directly during the copy phase (#228 archaeology)", () => {
    const skillsRegistry = upgradeBody.indexOf(
      'registry?.plugins?.["context-mode@context-mode"]',
    );
    // Multiple matches exist (one for the v1.0.114 hotfix, one for
    // skills sync). The skills-sync one is the LAST occurrence — find
    // the one followed by `Synced skills to active install path`.
    const skillsSync = upgradeBody.indexOf("Synced skills to active install path");
    expect(skillsRegistry).toBeGreaterThan(0);
    expect(skillsSync).toBeGreaterThan(skillsRegistry);

    const gate = upgradeBody.lastIndexOf("if (isCC)", skillsSync);
    const close = upgradeBody.indexOf("} // CC_PLUGIN_SYSTEM_PLATFORMS", skillsSync);
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(skillsSync);
    expect(close).toBeGreaterThan(skillsSync);
  });
});
