import "./isolate-agent-dir.ts";
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import {
  reportAgentState, releaseAgentState, reportAgentStateInBackground,
  releaseAgentStateInBackground, settleAgentStateInBackground,
  cancelBackgroundAgentStates, __backgroundAgentStateTest__,
} from "../pi-extension/subagents/herdr.ts";

function fixture(sleepMs = 300) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-background-"));
  const saved = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const callsFile = join(dir, "calls.jsonl");
  const eventsFile = join(dir, "events.jsonl");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "herdr"), `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const event = (kind) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ kind, args, pid: process.pid }) + '\\n');
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
event('start');
setTimeout(() => {
  event('end');
  if (existsSync(${JSON.stringify(join(dir, "fail"))})) {
    process.stderr.write(JSON.stringify({ error: { code: 'fixture_failure', message: 'fixture failure' }, id: 'cli:pane' }) + '\\n');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ result: {} }) + '\\n');
}, ${sleepMs});
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  const handlers = new Map<string, Function>();
  extension({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    events: { on: () => () => {} },
  } as any);
  const startedAt = Date.now() - 100;
  const activityDir = join(dir, "artifacts", "parent", "subagent-activity");
  mkdirSync(activityDir, { recursive: true });
  const wait = (base: string, id: string, pane: string, count: number) => {
    mkdirSync(base, { recursive: true });
    const value = { version: 1, runningChildId: id, startedAt, pane, name: id,
      herdrSession: process.env.HERDR_SESSION ?? "", pid: process.pid, count, updatedAt: Date.now() };
    writeFileSync(join(base, `${id}.json.owner`), JSON.stringify(value));
    writeFileSync(join(base, `${id}.json.wait`), JSON.stringify(value));
  };
  return {
    dir, bin, activityDir, startedAt, wait,
    events(): Array<{ kind: string; args: string[]; pid: number }> {
      return existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : [];
    },
    calls(): string[][] { return existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : []; },
    close() {
      handlers.get("session_shutdown")?.({}, {});
      __test__.runningSubagents.clear();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const scenario of ["status refresh", "recovered wait refresh", "sibling wait release"] as const) {
  it(`${scenario} keeps the event loop responsive with a 300 ms herdr CLI`, async () => {
    const f = fixture();
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let stop: (() => void) | undefined;
    try {
      histogram.enable();
      await delay(30);
      if (scenario === "status refresh") {
        const id = "running";
        __test__.runningSubagents.set(id, {
          id, name: id, surface: "w2:p2", cli: "pi", startTime: f.startedAt,
          sessionFile: join(f.dir, "child.jsonl"),
          statusState: createStatusState({ source: "pi", startTimeMs: f.startedAt }),
        } as any);
        __test__.startStatusRefresh({ sendMessage() {} } as any);
      } else {
        if (scenario === "recovered wait refresh") f.wait(f.activityDir, "recovered", "w2:p2", 1);
        else f.wait(join(f.dir, "artifacts", "sibling", "subagent-activity"), "sibling", "w3:p3", 0);
        stop = __test__.startHumanWaitRefresh({ sessionManager: {
          getSessionDir: () => f.dir, getSessionId: () => "parent",
        } } as any);
        if (scenario === "recovered wait refresh") rmSync(join(f.activityDir, "recovered.json.wait"));
      }
      await delay(1750);
      histogram.disable();
      const maxMs = histogram.max / 1e6;
      console.log(`${scenario} max event-loop delay ${maxMs.toFixed(3)} ms`);
      const calls = f.calls();
      assert.ok(calls.length > 0, "the timer must actually invoke the slow CLI");
      if (scenario !== "status refresh") assert.ok(calls.some((args) => args[1] === "release-agent"));
      assert.ok(maxMs < 20, `max event-loop delay ${maxMs.toFixed(3)} ms must be below 20 ms`);
    } finally {
      histogram.disable();
      stop?.();
      f.close();
      await __backgroundAgentStateTest__.drain();
    }
  });
}
