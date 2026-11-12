import "./isolate-agent-dir.ts"; // must stay first: no test may read the real ~/.pi/agent
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-roster-test-"));
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/**
 * Isolate agent discovery: temp project dir (cwd) with .pi/agents and a temp
 * global agent dir via PI_CODING_AGENT_DIR. The bundled agents under
 * ../agents always exist and are always discovered; tests account for them.
 */
async function withAgentEnv(
  fn: (paths: {
    root: string;
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "config", "agent");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ root, projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Mock ExtensionAPI that captures event handlers registered via pi.on(). */
function createCapturingMockApi() {
  const handlers: Record<string, any> = {};
  const registeredTools: Array<any> = [];
  return {
    handlers,
    registeredTools,
    api: {
      on(event: string, handler: any) {
        handlers[event] = handler;
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function makeBeforeAgentStartEvent() {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "do the work",
    systemPrompt: "current prompt",
    systemPromptOptions: {
      cwd: process.cwd(),
      sections: {} as Record<string, string>,
    },
  } as any;
}

async function renderRosterViaHandler(): Promise<string | undefined> {
  const { handlers, api } = createCapturingMockApi();
  subagentsModule.default(api);
  const handler = handlers["before_agent_start"];
  assert.ok(handler, "before_agent_start handler must be registered");
  const event = makeBeforeAgentStartEvent();
  await handler(event);
  return (event.systemPromptOptions as any).sections["available-agents"];
}

function rosterNames(roster: string): string[] {
  return roster
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^- ([^:]+): .*$/, "$1"));
}

const BUNDLED_AGENTS = ["oracle", "researcher", "reviewer", "scout", "worker"];

// --- Tests ---

describe("available-agents roster section", () => {
  it("lists global agents alongside bundled ones, sorted by name", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "alpha",
        "name: alpha\ndescription: Alpha agent for testing",
      );
      writeAgentFile(
        globalAgentsDir,
        "zeta",
        "name: zeta\ndescription: Zeta agent for testing",
      );
      const roster = await renderRosterViaHandler();
      assert.ok(roster, "roster section must be set");
      const names = rosterNames(roster);
      assert.deepEqual(names, [...new Set(["alpha", ...BUNDLED_AGENTS, "zeta"])].sort());
      assert.ok(roster.includes("- alpha: Alpha agent for testing"));
      assert.ok(roster.includes("- zeta: Zeta agent for testing"));
    });
  });

  it("uses (no description) for agents without a description", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(globalAgentsDir, "nodesc", "name: nodesc");
      const roster = await renderRosterViaHandler();
      assert.ok(roster);
      assert.ok(roster.includes("- nodesc: (no description)"));
    });
  });

  it("a project agent shadows a global agent of the same name", async () => {
    await withAgentEnv(async ({ globalAgentsDir, projectAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shared",
        "name: shared\ndescription: Global version of shared",
      );
      writeAgentFile(
        projectAgentsDir,
        "shared",
        "name: shared\ndescription: Project version of shared",
      );
      const roster = await renderRosterViaHandler();
      assert.ok(roster);
      assert.ok(roster.includes("- shared: Project version of shared"));
      assert.ok(!roster.includes("Global version of shared"));
      assert.equal(rosterNames(roster).filter((n) => n === "shared").length, 1);
    });
  });

  it("omits agents with disable-model-invocation", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "hidden",
        "name: hidden\ndescription: Should not appear\ndisable-model-invocation: true",
      );
      const roster = await renderRosterViaHandler();
      assert.ok(roster);
      assert.ok(!roster.includes("hidden"));
      assert.ok(!roster.includes("Should not appear"));
    });
  });

  it("the PI_SUBAGENT_ALLOWED allowlist filters the roster", async () => {
    await withAgentEnv(async () => {
      const previous = process.env.PI_SUBAGENT_ALLOWED;
      process.env.PI_SUBAGENT_ALLOWED = "scout,worker";
      try {
        const roster = await renderRosterViaHandler();
        assert.ok(roster);
        assert.deepEqual(rosterNames(roster), ["scout", "worker"]);
      } finally {
        if (previous === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
        else process.env.PI_SUBAGENT_ALLOWED = previous;
      }
    });
  });

  it("produces byte-identical output across two calls when no agent file changed", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "stable",
        "name: stable\ndescription: Stable agent",
      );
      const first = await renderRosterViaHandler();
      const second = await renderRosterViaHandler();
      assert.ok(first);
      assert.equal(first, second);
    });
  });

  it("a new agent file appears on the next call", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      const before = await renderRosterViaHandler();
      assert.ok(before);
      assert.ok(!before.includes("latecomer"));
      writeAgentFile(
        globalAgentsDir,
        "latecomer",
        "name: latecomer\ndescription: Arrived after the first call",
      );
      const after = await renderRosterViaHandler();
      assert.ok(after);
      assert.ok(after.includes("- latecomer: Arrived after the first call"));
    });
  });

  it("sets no section when there are zero agents", async () => {
    await withAgentEnv(async () => {
      const previous = process.env.PI_SUBAGENT_ALLOWED;
      // An allowlist naming no discoverable agent leaves zero permitted agents.
      process.env.PI_SUBAGENT_ALLOWED = "does-not-exist";
      try {
        const roster = await renderRosterViaHandler();
        assert.equal(roster, undefined);
      } finally {
        if (previous === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
        else process.env.PI_SUBAGENT_ALLOWED = previous;
      }
    });
  });

  it("a throwing discovery skips the section without throwing", async () => {
    await withAgentEnv(async ({ projectDir, projectAgentsDir }) => {
      // .pi/agents exists as a regular file: existsSync passes, readdirSync
      // throws ENOTDIR inside discoverAgentDefinitions.
      rmSync(projectAgentsDir, { recursive: true, force: true });
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectAgentsDir, "not a directory");
      const roster = await renderRosterViaHandler();
      assert.equal(roster, undefined);
    });
  });

  it("does not return or replace the system prompt", async () => {
    const { handlers, api } = createCapturingMockApi();
    subagentsModule.default(api);
    const handler = handlers["before_agent_start"];
    assert.ok(handler);
    const event = makeBeforeAgentStartEvent();
    const result = await handler(event);
    assert.equal(result, undefined);
    assert.equal(event.systemPrompt, "current prompt");
  });
});

describe("getFrontmatterValue quote handling", () => {
  const parse = (frontmatter: string) =>
    (subagentsModule as any).__test__.parseAgentDefinition(
      `---\n${frontmatter}\n---\n\nYou are a test agent.\n`,
      "fixture",
    );

  it("strips a matching pair of surrounding double quotes from a description", () => {
    const parsed = parse(
      'name: quoted\ndescription: "Read-only repo recon. Not for edits: use worker."',
    );
    assert.equal(
      parsed.description,
      "Read-only repo recon. Not for edits: use worker.",
    );
  });

  it("strips a matching pair of surrounding single quotes", () => {
    const parsed = parse("name: squoted\ndescription: 'Single quoted value'");
    assert.equal(parsed.description, "Single quoted value");
  });

  it('unescapes backslash-quote and backslash-backslash inside a double-quoted value', () => {
    const parsed = parse(
      'name: escaped\ndescription: "He said \\"hi\\" from C:\\\\tmp"',
    );
    assert.equal(parsed.description, 'He said "hi" from C:\\tmp');
  });

  it("leaves an unquoted value byte-identical", () => {
    const parsed = parse("name: plain\ndescription: plain unquoted value");
    assert.equal(parsed.description, "plain unquoted value");
  });

  it("leaves a lone leading quote unchanged", () => {
    const parsed = parse('name: halfquote\ndescription: "half quoted');
    assert.equal(parsed.description, '"half quoted');
  });

  it("resolves a quoted model value without quotes", () => {
    const parsed = parse('name: modeled\nmodel: "openrouter/z-ai/glm-5.3"');
    assert.equal(parsed.model, "openrouter/z-ai/glm-5.3");
  });

  it("shows a quoted description unquoted in the roster", async () => {
    await withAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "yamlquoted",
        'name: yamlquoted\ndescription: "Read-only repo recon. Not for edits: use worker."',
      );
      const roster = await renderRosterViaHandler();
      assert.ok(roster);
      assert.ok(
        roster.includes("- yamlquoted: Read-only repo recon. Not for edits: use worker."),
      );
      assert.ok(!roster.includes('"Read-only'));
    });
  });
});

describe("subagents_list wording", () => {
  it("no longer tells the model to only call on explicit request", () => {
    const { registeredTools, api } = createCapturingMockApi();
    subagentsModule.default(api);
    const tool = registeredTools.find((t) => t.name === "subagents_list");
    assert.ok(tool, "subagents_list must be registered");
    assert.ok(!tool.description.includes("Only call"), tool.description);
    assert.ok(!tool.promptSnippet.includes("Only call"), tool.promptSnippet);
    assert.ok(tool.description.includes("available-agents"), tool.description);
    assert.ok(tool.promptSnippet.includes("available-agents"), tool.promptSnippet);
  });
});
