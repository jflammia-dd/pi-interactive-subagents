import "./isolate-agent-dir.ts"; // must stay first: no test may read the real ~/.pi/agent
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  isAcceptableExtensionSpecifier,
  resolveKeyHint,
  userMessageDelivery,
} from "../pi-extension/subagents/compat.ts";

function createMockApi() {
  const commands: Array<any> = [];
  const sent: Array<{ message: string; options: unknown }> = [];
  const api = {
    on() {},
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands.push({ name, ...command });
    },
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options });
    },
    sendMessage() {},
    getAllTools() {
      return [];
    },
  } as any;
  return { api, commands, sent };
}

function createCtx(idle: boolean) {
  const notices: string[] = [];
  return {
    notices,
    ctx: {
      isIdle: () => idle,
      ui: { notify: (msg: string) => notices.push(msg) },
    } as any,
  };
}

describe("userMessageDelivery", () => {
  it("sends immediately when the agent is idle", () => {
    assert.equal(userMessageDelivery(true), undefined);
  });

  it("queues as a follow-up while a run is active", () => {
    assert.deepEqual(userMessageDelivery(false), { deliverAs: "followUp" });
  });
});

describe("/subagent command delivery", () => {
  it("passes no delivery options when the agent is idle", async () => {
    const { api, commands, sent } = createMockApi();
    (subagentsModule as any).default(api);
    const command = commands.find((c) => c.name === "subagent");
    assert.ok(command, "the /subagent command is registered");
    const { ctx } = createCtx(true);
    await command.handler("reviewer look at the diff", ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /Use subagent with agent: "reviewer"/);
    assert.equal(sent[0].options, undefined);
  });

  it("queues the message as a follow-up while a run is active", async () => {
    const { api, commands, sent } = createMockApi();
    (subagentsModule as any).default(api);
    const command = commands.find((c) => c.name === "subagent");
    const { ctx } = createCtx(false);
    await command.handler("reviewer look at the diff", ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
  });

  it("sends nothing for an unknown agent", async () => {
    const { api, commands, sent } = createMockApi();
    (subagentsModule as any).default(api);
    const command = commands.find((c) => c.name === "subagent");
    const { ctx, notices } = createCtx(false);
    await command.handler("no-such-agent-xyz do a thing", ctx);
    assert.equal(sent.length, 0);
    assert.match(notices[0], /not found/);
  });
});

describe("resolveKeyHint", () => {
  const fallback = (id: string, description: string) => `fallback:${id}:${description}`;

  it("prefers the keyHint injected through the renderer options", () => {
    const hint = resolveKeyHint({ keyHint: (id, d) => `injected:${id}:${d}` }, fallback);
    assert.equal(hint("app.tools.expand", "to expand"), "injected:app.tools.expand:to expand");
  });

  it("falls back to the imported keyHint when options carry none", () => {
    assert.equal(resolveKeyHint({}, fallback)("app.tools.expand", "to expand"), "fallback:app.tools.expand:to expand");
    assert.equal(resolveKeyHint(undefined, fallback)("a", "b"), "fallback:a:b");
  });
});

describe("isAcceptableExtensionSpecifier", () => {
  it("accepts absolute paths and builtin specifiers", () => {
    assert.equal(isAcceptableExtensionSpecifier("/Users/someone/ext/index.ts"), true);
    assert.equal(isAcceptableExtensionSpecifier("builtin:mcp"), true);
    assert.equal(isAcceptableExtensionSpecifier("builtin:codemode"), true);
  });

  it("rejects package specifiers and relative paths", () => {
    for (const spec of ["npm:some-package", "npm:some-package@1.2.3", "git:github.com/x/y", "https://example.com/x.ts", "./ext.ts", "ext/index.ts", ""]) {
      assert.equal(isAcceptableExtensionSpecifier(spec), false, spec);
    }
  });
});

describe("registerToolExtension specifier check", () => {
  it("rejects a non-absolute extension path and leaves the registry untouched", () => {
    assert.throws(
      () => subagentsModule.registerToolExtension("compat_test_relative", "./ext.ts"),
      /absolute path or a builtin: specifier/,
    );
    const registry = (globalThis as any).__pi_extra_tool_extensions as Map<string, string>;
    assert.equal(registry.has("compat_test_relative"), false);
  });

  it("rejects an npm specifier", () => {
    assert.throws(
      () => subagentsModule.registerToolExtension("compat_test_npm", "npm:some-package"),
      /absolute path or a builtin: specifier/,
    );
  });

  it("accepts an absolute path and stays idempotent for the same path", () => {
    subagentsModule.registerToolExtension("compat_test_abs", "/tmp/compat-test-ext/index.ts");
    subagentsModule.registerToolExtension("compat_test_abs", "/tmp/compat-test-ext/index.ts");
    const registry = (globalThis as any).__pi_extra_tool_extensions as Map<string, string>;
    assert.equal(registry.get("compat_test_abs"), "/tmp/compat-test-ext/index.ts");
    registry.delete("compat_test_abs");
  });

  it("accepts a builtin specifier", () => {
    subagentsModule.registerToolExtension("compat_test_builtin", "builtin:mcp");
    const registry = (globalThis as any).__pi_extra_tool_extensions as Map<string, string>;
    assert.equal(registry.get("compat_test_builtin"), "builtin:mcp");
    registry.delete("compat_test_builtin");
  });
});

describe("test isolation", () => {
  it("removes inherited PI_SUBAGENT_* variables so a suite run inside a subagent pane matches a plain shell", () => {
    const leaked = Object.keys(process.env).filter((name) => name.startsWith("PI_SUBAGENT_"));
    assert.deepEqual(leaked, []);
  });
});
