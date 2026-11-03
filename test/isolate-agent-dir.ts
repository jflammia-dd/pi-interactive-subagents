/**
 * Import this FIRST in any unit test file that loads the extension.
 *
 * The extension resolves agents, settings and tool extensions from
 * PI_CODING_AGENT_DIR (default ~/.pi/agent). Left alone, tests read whatever
 * the developer has installed there - a customised worker.md made the bundled
 * defaults assertions fail - and can create session dirs in it. Point the whole
 * test process at an empty throwaway dir instead. An inherited value is
 * deliberately overridden: the suite must behave the same on every machine.
 *
 * Tests that exercise user-level overrides build their own fixture dir
 * (withIsolatedAgentEnv in test.ts) and restore this one afterwards.
 *
 * The same rule covers the PI_SUBAGENT_* variables. A suite run from inside a
 * subagent pane inherits that pane's identity, allowlist and surface, which
 * turns top-level spawn tests into child-agent tests. They are removed here so
 * the suite behaves the same in a subagent pane as in a plain shell. Tests that
 * need one of them set it explicitly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("PI_SUBAGENT_")) delete process.env[name];
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
