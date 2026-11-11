import "./isolate-agent-dir.ts";
import { it } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, renameSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { __test__ } from "../pi-extension/subagents/index.ts";
import {
  releaseAgentState, reportAgentState, releaseAgentStateInBackground,
  reportAgentStateInBackground, settleAgentStateInBackground, isHerdrAvailable,
  cancelBackgroundAgentStates, __backgroundAgentStateTest__,
} from "../pi-extension/subagents/herdr.ts";

const DAY = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL = 60_000;
const DEAD_PID = 2147483647;

function fixture(pathPosition = 1) {
  const dir = mkdtempSync(join(tmpdir(), "stale-wait-storm-"));
  const saved = Object.fromEntries(["PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SESSION", "PI_SUBAGENTS_HERDR_BIN"]
    .map((key) => [key, process.env[key]]));
  const wallNow = Date.now;
  let clock = wallNow();
  const root = join(dir, "artifacts");
  const own = join(root, "parent", "subagent-activity");
  mkdirSync(own, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const callsFile = join(dir, "calls.jsonl");
  const modeFile = join(dir, "mode.json");
  const mode = (code = "pane_not_found", stream = "stderr", text?: string) =>
    writeFileSync(modeFile, JSON.stringify({ code, stream, text }));
  mode();
  const stub = join(bin, "herdr");
  writeFileSync(stub, `#!${process.execPath} --single-threaded
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, executable: process.argv[1] }) + '\\n');
const mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, 'utf8'));
if (mode.code === 'success') process.stdout.write(JSON.stringify({ result: {} }) + '\\n');
else {
  process[mode.stream].write(mode.text ?? JSON.stringify({ error: { code: mode.code, message: 'pane X not found' } }));
  process.exitCode = 1;
}
`, { mode: 0o755 });
  const decoys = Array.from({ length: pathPosition - 1 }, (_, i) => {
    const entry = join(dir, `empty-${i}`);
    mkdirSync(entry);
    return entry;
  });
  // Keep live herdr installations out of the fixture's search path.
  process.env.PATH = [...decoys, bin, "/bin", "/usr/bin"].join(":");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SESSION = "stale-storm-fixture";
  delete process.env.PI_SUBAGENTS_HERDR_BIN;
  Date.now = () => clock;
  const calls = (): Array<{ args: string[]; executable: string }> => existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const wait = (session: string, id: string, patch: Record<string, unknown> = {}, age = 0) => {
    const base = join(root, session, "subagent-activity");
    mkdirSync(base, { recursive: true });
    const value = {
      version: 1, runningChildId: id, startedAt: clock - 2 * DAY,
      pane: `w2:p${id.replace(/[^a-z0-9]/gi, "")}`, name: id, herdrSession: process.env.HERDR_SESSION,
      pid: DEAD_PID, count: 1, updatedAt: clock, ...patch,
    };
    const file = join(base, `${id}.json.wait`);
    writeFileSync(join(base, `${id}.json.owner`), JSON.stringify(value));
    writeFileSync(file, JSON.stringify(value));
    utimesSync(file, new Date(clock - age), new Date(clock - age));
    return file;
  };
  let stop: (() => void) | undefined;
  let tick = () => {};
  const start = async () => {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void) => { tick = fn; return { unref() {} }; }) as any;
    globalThis.clearInterval = (() => {}) as any;
    try {
      stop = __test__.startHumanWaitRefresh({ sessionManager: {
        getSessionDir: () => dir, getSessionId: () => "parent",
      } } as any);
    } finally {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    }
    await __backgroundAgentStateTest__.drain();
  };
  return {
    dir, root, own, bin, stub, calls, mode, wait, start,
    advance(ms: number) { clock += ms; },
    now() { return clock; },
    async tick(ms = 1000) {
      clock += ms;
      const began = performance.now();
      tick();
      const elapsed = performance.now() - began;
      await __backgroundAgentStateTest__.drain();
      return elapsed;
    },
    async close() {
      stop?.();
      cancelBackgroundAgentStates();
      await __backgroundAgentStateTest__.drain();
      __test__.runningSubagents.clear();
      Date.now = wallNow;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spyExecutables() {
  const seen: string[] = [];
  const asyncOriginal = childProcess.execFile;
  const syncOriginal = childProcess.execFileSync;
  childProcess.execFile = ((file: string, ...args: any[]) => {
    seen.push(file);
    return (asyncOriginal as any)(file, ...args);
  }) as any;
  childProcess.execFileSync = ((file: string, ...args: any[]) => {
    seen.push(file);
    return (syncOriginal as any)(file, ...args);
  }) as any;
  syncBuiltinESMExports();
  return { seen, close() {
    childProcess.execFile = asyncOriginal;
    childProcess.execFileSync = syncOriginal;
    syncBuiltinESMExports();
  } };
}

it("pane_not_found satisfies sync and background releases from either JSON stream", async () => {
  const f = fixture();
  try {
    for (const stream of ["stdout", "stderr"]) {
      f.mode("pane_not_found", stream);
      const name = `gone-${stream}`;
      assert.equal(releaseAgentState("w2:p2", name), true);
      const settled: boolean[] = [];
      assert.equal(releaseAgentStateInBackground("w2:p2", name, "scope", (ok) => settled.push(ok)), false);
      releaseAgentStateInBackground("w2:p2", name, "scope", (ok) => settled.push(ok));
      await __backgroundAgentStateTest__.drain();
      assert.deepEqual(settled, [true, true]);
      const count = f.calls().length;
      assert.equal(releaseAgentStateInBackground("w2:p2", name, "scope"), true);
      await __backgroundAgentStateTest__.drain();
      assert.equal(f.calls().length, count);
      releaseAgentStateInBackground("w2:p2", name, "new-scope");
      await __backgroundAgentStateTest__.drain();
      assert.equal(f.calls().length, count + 1, "a changed identity needs a fresh acknowledgement");
      const result: boolean[] = [];
      settleAgentStateInBackground("w3:p3", name, "scope", (ok) => result.push(ok));
      await __backgroundAgentStateTest__.drain();
      assert.deepEqual(result, [true], "a failed idle report must still release a gone pane");
      const reported: boolean[] = [];
      reportAgentStateInBackground("w4:p4", name, "blocked", undefined, "scope", (ok) => reported.push(ok));
      await __backgroundAgentStateTest__.drain();
      assert.deepEqual(reported, [false], "pane_not_found does not satisfy a state report");
    }
    for (const text of ["pane_not_found", '{"error":{"message":"pane_not_found"}}', '{"error":{"code":"pane_not_found"}',
      JSON.stringify({ error: { code: "permission_denied", message: "pane_not_found" } })]) {
      f.mode("other", "stderr", text);
      assert.equal(releaseAgentState("w2:p2", "malformed"), false, "only a parsed error code can satisfy release");
    }
  } finally { await f.close(); }
});

it("herdr uses a cached absolute PATH entry 8 and honors the executable override", async () => {
  const f = fixture(8);
  const spy = spyExecutables();
  const access = fs.accessSync;
  let lookups = 0;
  fs.accessSync = ((...args: any[]) => { lookups++; return (access as any)(...args); }) as any;
  syncBuiltinESMExports();
  try {
    f.mode("success");
    assert.equal(isHerdrAvailable(), true);
    assert.equal(releaseAgentState("w2:p2", "absolute"), true);
    releaseAgentStateInBackground("w3:p3", "absolute", "a");
    await __backgroundAgentStateTest__.drain();
    assert.ok(spy.seen.length >= 2);
    assert.ok(spy.seen.every((file) => file === f.stub), `all launches must use ${f.stub}, got ${JSON.stringify(spy.seen)}`);
    assert.equal(lookups, 8, "availability and both commands share one cached PATH search");
    const override = join(f.dir, "override with spaces");
    fs.copyFileSync(f.stub, override);
    process.env.PI_SUBAGENTS_HERDR_BIN = override;
    process.env.PATH = join(f.dir, "empty-0");
    assert.equal(isHerdrAvailable(), true, "an override does not need herdr on PATH");
    spy.seen.length = 0;
    assert.equal(releaseAgentState("w2:p2", "override"), true);
    releaseAgentStateInBackground("w3:p3", "override", "b");
    await __backgroundAgentStateTest__.drain();
    assert.deepEqual(spy.seen, [override, override]);
    assert.ok(f.calls().slice(-2).every((call) => call.executable === override));
  } finally { fs.accessSync = access; spy.close(); await f.close(); }
});

it("release JSON parsing accepts large structured errors without trusting malformed oversized output", async () => {
  const f = fixture();
  try {
    f.mode("other", "stderr", JSON.stringify({ error: { code: "pane_not_found" }, padding: "x".repeat(20_000) }));
    assert.equal(releaseAgentState("w2:p2", "large"), true);
    f.mode("other", "stderr", "x".repeat(1_100_000));
    assert.equal(releaseAgentState("w2:p2", "oversized"), false);
  } finally { await f.close(); }
});

it("an ENOENT cached executable is re-resolved for sync and queued calls", async () => {
  for (const background of [false, true]) {
    const f = fixture();
    const spy = spyExecutables();
    try {
      f.mode("success");
      const later = join(f.dir, "later");
      mkdirSync(later);
      process.env.PATH += `:${later}`;
      assert.equal(releaseAgentState("w2:p2", "prime"), true);
      const replacement = join(later, "herdr");
      renameSync(f.stub, replacement);
      spy.seen.length = 0;
      if (background) {
        const settled: boolean[] = [];
        releaseAgentStateInBackground("w3:p3", "replacement", "scope", (ok) => settled.push(ok));
        await __backgroundAgentStateTest__.drain();
        assert.deepEqual(settled, [true]);
      } else assert.equal(releaseAgentState("w3:p3", "replacement"), true);
      assert.deepEqual(spy.seen, [f.stub, replacement]);
    } finally { spy.close(); await f.close(); }
  }
});

it("missing executable resolution falls back to the bare name only once", async () => {
  const f = fixture();
  const spy = spyExecutables();
  try {
    f.mode("success");
    assert.equal(releaseAgentState("w2:p2", "prime"), true);
    renameSync(f.stub, join(f.bin, "unavailable"));
    spy.seen.length = 0;
    assert.equal(releaseAgentState("w3:p3", "missing"), false);
    assert.deepEqual(spy.seen, [f.stub, "herdr"]);
    spy.seen.length = 0;
    const settled: boolean[] = [];
    releaseAgentStateInBackground("w4:p4", "missing", "scope", (ok) => settled.push(ok));
    await __backgroundAgentStateTest__.drain();
    assert.deepEqual(settled, [false]);
    assert.deepEqual(spy.seen, ["herdr"], "a failed bare-name fallback must not loop");
  } finally { spy.close(); await f.close(); }
});

it("only dead old waits are pruned after acknowledged release", async () => {
  const f = fixture();
  try {
    const liveActive = f.wait("sibling", "live-active", { pid: process.pid }, DAY + 1000);
    const liveCleared = f.wait("sibling", "live-cleared", { pid: process.pid, count: 0 }, DAY + 1000);
    const liveExpired = f.wait("sibling", "live-expired", { pid: process.pid, updatedAt: f.now() - 9000 }, DAY + 1000);
    const young = f.wait("sibling", "dead-young", {}, DAY - 1000);
    const boundary = f.wait("sibling", "dead-boundary", {}, DAY);
    const old = f.wait("sibling", "dead-old", {}, DAY + 1000);
    await f.start();
    const released = f.calls().filter((call) => call.args[1] === "release-agent").map((call) => call.args[2]);
    assert.ok(!released.includes("w2:pliveactive"));
    assert.ok(released.includes("w2:plivecleared"));
    assert.ok(released.includes("w2:pliveexpired"));
    for (const file of [liveActive, liveCleared, liveExpired, young, boundary]) assert.ok(existsSync(file), file);
    assert.equal(existsSync(old), false, "a dead wait older than 24 hours is removed after pane_not_found settles");
    await f.tick(SCAN_INTERVAL);
    assert.equal(existsSync(young), false, "an acknowledged young wait is pruned after aging out");
    for (const file of [liveActive, liveCleared, liveExpired]) assert.ok(existsSync(file), "live writers are never pruned");
  } finally { await f.close(); }
});

it("pruning revalidates replacement identities and transient failures keep their wait files", async () => {
  const f = fixture();
  try {
    f.mode("fixture_failure");
    const file = f.wait("sibling", "retry", {}, DAY + 1000);
    await f.start();
    assert.ok(existsSync(file));
    assert.equal(f.calls().length, 1);
    await f.tick(4999);
    assert.equal(f.calls().length, 1);
    await f.tick(1);
    assert.equal(f.calls().length, 2, "non-pane_not_found release failures retry after five seconds");
    f.mode();
    await f.tick(5000);
    assert.equal(f.calls().length, 3);
    assert.equal(existsSync(file), false);
    const replaced = f.wait("sibling", "replaced", {}, DAY + 1000);
    const starting = f.tick(SCAN_INTERVAL);
    f.wait("sibling", "replaced", { pid: process.pid });
    await starting;
    assert.ok(existsSync(replaced), "an acknowledgement for the old identity cannot delete its live replacement");
  } finally { await f.close(); }
});

it("sibling changes wait for the scan interval while the own folder is scanned each tick", async () => {
  const f = fixture();
  try {
    const file = f.wait("sibling", "changed", { pid: process.pid });
    await f.start();
    assert.equal(f.calls().length, 0);
    const value = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...value, count: 0 }));
    await f.tick(SCAN_INTERVAL - 1);
    assert.equal(f.calls().length, 0, "sibling changes must not trigger a scan before 60 seconds");
    await f.tick(1);
    assert.equal(f.calls().length, 1, "the next sibling scan discovers the cleared live wait");
    const own = f.wait("parent", "own", { pid: process.pid });
    await f.tick(1000);
    assert.ok(f.calls().some((call) => call.args[1] === "report-agent" && call.args[2] === "w2:pown"));
    assert.ok(existsSync(own));
  } finally { await f.close(); }
});

it("120 folders and 150 gone panes do not repeat releases over twelve seconds of ticks", async () => {
  const f = fixture();
  const reads = { root: 0, own: 0, sibling: 0 };
  const readdir = fs.readdirSync;
  const execFile = childProcess.execFile;
  // Interpreter startup for 150 fixture processes needs more time than the native CLI.
  childProcess.execFile = ((file: string, args: string[], options: any, callback: any) =>
    execFile(file, args, { ...options, timeout: 20_000 }, callback)) as any;
  fs.readdirSync = ((file: any, ...args: any[]) => {
    if (String(file) === f.root) reads.root++;
    else if (String(file) === f.own) reads.own++;
    else if (String(file).startsWith(f.root)) reads.sibling++;
    return (readdir as any)(file, ...args);
  }) as any;
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 119; i++) mkdirSync(join(f.root, `sibling-${i}`, "subagent-activity"), { recursive: true });
    for (let i = 0; i < 150; i++) f.wait(`sibling-${i % 119}`, `gone${i}`);
    await f.start();
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      await delay(1000);
      times.push(await f.tick());
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const count = f.calls().filter((call) => call.args[1] === "release-agent").length;
    console.log(`storm calls=${count} rootReads=${reads.root} siblingReads=${reads.sibling} ownReads=${reads.own} tickMedianMs=${median.toFixed(3)} tickMaxMs=${Math.max(...times).toFixed(3)}`);
    assert.equal(count, 150, "each distinct stale file needs one satisfied release, not five-second retry bursts");
    assert.equal(reads.root, 1, "the artifacts root is enumerated only at startup during twelve seconds");
    assert.equal(reads.sibling, 119);
    assert.equal(reads.own, 13);
    assert.ok(median < 15, `own-folder median tick time ${median.toFixed(3)} ms must stay small`);
  } finally {
    fs.readdirSync = readdir;
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
    await f.close();
  }
});
