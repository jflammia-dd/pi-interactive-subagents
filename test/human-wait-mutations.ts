// Run from the repository root. Mutants execute only in isolated temporary copies.
// This preserves the verifier's 43 mutations, with source matches updated for the fix.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const mutants: string[][] = [
  [
    "M01 never decrement on ui_prompt_end",
    "pi-extension/subagents/human-wait.ts",
    "Math.max(0, depth - 1)",
    "depth"
  ],
  [
    "M02 ignore lease expiry",
    "pi-extension/subagents/human-wait.ts",
    "const expired = !options.deferExpiry && now - value.updatedAt > HUMAN_WAIT_LEASE_MS;",
    "const expired = false;"
  ],
  [
    "M03a skip .exit clearing",
    "pi-extension/subagents/index.ts",
    " && !existsSync(`${running.sessionFile}.exit`)",
    ""
  ],
  [
    "M03b skip activity phase done clearing",
    "pi-extension/subagents/index.ts",
    "running.activity?.phase !== \"done\" && ",
    ""
  ],
  [
    "M03c child shutdown no clear",
    "pi-extension/subagents/human-wait.ts",
    "if (state) { state.count = 0; flush(); }",
    "if (state) { state.count = 0; }"
  ],
  [
    "M04 accept custom kind",
    "pi-extension/subagents/human-wait.ts",
    "new Set([\"select\", \"confirm\", \"input\", \"editor\"])",
    "new Set([\"select\", \"confirm\", \"input\", \"editor\", \"custom\"])"
  ],
  [
    "M05a skip run id check",
    "pi-extension/subagents/human-wait.ts",
    "value.runningChildId !== id ||",
    ""
  ],
  [
    "M05b skip startedAt check (stale older run live)",
    "pi-extension/subagents/human-wait.ts",
    "(startedAt !== undefined && value.startedAt !== startedAt) ||",
    ""
  ],
  [
    "M05c skip pid liveness",
    "pi-extension/subagents/human-wait.ts",
    "if (!alive && !options.allowDead) return null;",
    ""
  ],
  [
    "M05d skip pane check (index)",
    "pi-extension/subagents/index.ts",
    "wait.pane === running.surface && ",
    ""
  ],
  [
    "M05e skip name check (index)",
    "pi-extension/subagents/index.ts",
    "wait.name === running.name && ",
    ""
  ],
  [
    "M05f skip herdrSession check",
    "pi-extension/subagents/human-wait.ts",
    "value.herdrSession !== (process.env.HERDR_SESSION ?? \"\") ||",
    ""
  ],
  [
    "M07a never restore prior state",
    "pi-extension/subagents/index.ts",
    "const state = wait && wait.pane === running.surface && wait.name === running.name && wait.count > 0\n    ? \"blocked\" : HERDR_STATE_BY_KIND[snapshot.kind];",
    "const state = wait && wait.pane === running.surface && wait.name === running.name && wait.count > 0\n    ? \"blocked\" : (running.herdrState === \"blocked\" ? undefined : HERDR_STATE_BY_KIND[snapshot.kind]);"
  ],
  [
    "M07b orphan release skips idle report",
    "pi-extension/subagents/index.ts",
    "reportAgentState(prior.surface, prior.name, \"idle\");\n    if (!release",
    "if (!release"
  ],
  [
    "M08a seq no timestamp seed",
    "pi-extension/subagents/herdr.ts",
    "Math.max(globals[REPORT_SEQ_KEY] || 0, Date.now() * 1000) + 1",
    "(globals[REPORT_SEQ_KEY] || 0) + 1"
  ],
  [
    "M08b seq not shared via globalThis",
    "pi-extension/subagents/herdr.ts",
    "globals[REPORT_SEQ_KEY] = seq;",
    ""
  ],
  [
    "M08c report returns true always",
    "pi-extension/subagents/herdr.ts",
    "    return true;\n  } catch { return false; }\n}\n\n/** Hand lifecycle",
    "    return true;\n  } catch { return true; }\n}\n\n/** Hand lifecycle"
  ],
  [
    "M08d cache state even on failed report",
    "pi-extension/subagents/index.ts",
    "running.herdrState = reportAgentState(running.surface, running.name, state, snapshot.activityLabel ?? undefined)\n    ? state : undefined;",
    "reportAgentState(running.surface, running.name, state, snapshot.activityLabel ?? undefined);\n  running.herdrState = state;"
  ],
  [
    "M08e release without seq",
    "pi-extension/subagents/herdr.ts",
    "      \"--seq\", String(nextReportSeq()),\n    ], 2000);\n    return true;\n  } catch { return false; }\n}\n\n/**",
    "    ], 2000);\n    return true;\n  } catch { return false; }\n}\n\n/**"
  ],
  [
    "M08f recovered.reported always true",
    "pi-extension/subagents/index.ts",
    "startedAt: wait.startedAt, state, reported,",
    "startedAt: wait.startedAt, state, reported: true,"
  ],
  [
    "M09a never clean dead temps",
    "pi-extension/subagents/human-wait.ts",
    "if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) {",
    "if (false) {"
  ],
  [
    "M09b clean live writer temps too",
    "pi-extension/subagents/human-wait.ts",
    "&& !processAlive(pid)) {",
    ") {"
  ],
  [
    "M09c failed flush leaves temp",
    "pi-extension/subagents/human-wait.ts",
    "      try { unlinkSync(temp); } catch {}\n      return false;",
    "      return false;"
  ],
  [
    "M10a no size cap",
    "pi-extension/subagents/human-wait.ts",
    "readRegularFile(file, 4096)",
    "readRegularFile(file, 1024 * 1024)"
  ],
  [
    "M10b no future-updatedAt check",
    "pi-extension/subagents/human-wait.ts",
    "value.updatedAt > now + HEARTBEAT_MS) return null;",
    "false) return null;"
  ],
  [
    "M10c no count cap",
    "pi-extension/subagents/human-wait.ts",
    "|| value.count > MAX_DEPTH",
    ""
  ],
  [
    "M10d pane regex off",
    "pi-extension/subagents/human-wait.ts",
    " || !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(value.pane)",
    ""
  ],
  [
    "M10e id regex off",
    "pi-extension/subagents/human-wait.ts",
    "        !/^[a-z0-9_-]{1,64}$/i.test(id) ||",
    ""
  ],
  [
    "M11a orphan: no skip of own pane",
    "pi-extension/subagents/index.ts",
    "wait.pane === process.env.HERDR_PANE_ID ||",
    ""
  ],
  [
    "M11b orphan: no release when wait vanishes",
    "pi-extension/subagents/index.ts",
    "for (const file of recovered.keys()) if (!seen.has(file)) release(file);",
    ""
  ],
  [
    "M11c orphan: expired waits recovered",
    "pi-extension/subagents/index.ts",
    "(wait.expired && !recovered.has(file))",
    "false"
  ],
  [
    "M11d orphan: cleanup on stop skipped",
    "pi-extension/subagents/index.ts",
    "for (const file of recovered.keys()) release(file, Date.now(), true);",
    ""
  ],
  [
    "M11e orphan: live runner not skipped",
    "pi-extension/subagents/index.ts",
    "if (runningSubagents.has(id)) { recovered.delete(file); continue; }",
    ""
  ],
  [
    "M12a heartbeat never started",
    "pi-extension/subagents/human-wait.ts",
    "else if (!heartbeat) {",
    "else if (false) {"
  ],
  [
    "M12b rpiv tool end no release",
    "pi-extension/subagents/human-wait.ts",
    "if (questions.delete(event.toolCallId)) publish();",
    ""
  ],
  [
    "M12c no teardown on shutdown",
    "pi-extension/subagents/human-wait.ts",
    "pi.on(\"session_shutdown\", teardown);",
    ""
  ],
  [
    "M12d explicit depth no decrement",
    "pi-extension/subagents/human-wait.ts",
    "Math.max(0, explicitDepth - 1)",
    "explicitDepth"
  ],
  [
    "M12e rpiv active false ignored",
    "pi-extension/subagents/human-wait.ts",
    "else if (active === false) questions.delete(toolCallId);",
    ""
  ],
  [
    "M12f session_start no teardown",
    "pi-extension/subagents/human-wait.ts",
    "pi.on(\"session_start\", (_event, ctx) => {\n    teardown();",
    "pi.on(\"session_start\", (_event, ctx) => {"
  ],
  [
    "M13a non-atomic write",
    "pi-extension/subagents/human-wait.ts",
    "writeFileSync(temp, `${JSON.stringify(state)}\\n`, { mode: 0o600, flag: \"wx\" });\n      renameSync(temp, file);",
    "writeFileSync(file, `${JSON.stringify(state)}\\n`, { mode: 0o600 });"
  ],
  [
    "M13b file mode 0644",
    "pi-extension/subagents/human-wait.ts",
    "writeFileSync(temp, `${JSON.stringify(state)}\\n`, { mode: 0o600, flag: \"wx\" });",
    "writeFileSync(temp, `${JSON.stringify(state)}\\n`, { mode: 0o644, flag: \"wx\" });"
  ],
  [
    "M14 wait applied outside HERDR_ENV",
    "pi-extension/subagents/index.ts",
    "process.env.HERDR_ENV === \"1\" && running.activityFile &&",
    "running.activityFile &&"
  ],
  [
    "M15 finish skips release",
    "pi-extension/subagents/index.ts",
    "  running.herdrState = undefined;\n  releaseAgentState(running.surface, running.name);",
    "  running.herdrState = undefined;"
  ]
];
const root = process.cwd();
const out = resolve(process.argv[2] ?? "/tmp/pis-fix-out/mutations2");
mkdirSync(out, { recursive: true });
const selected = new Set(process.argv.slice(3));
const queue = mutants.filter((m) => !selected.size || selected.has(m[0].split(" ")[0]));
const results: Array<{ name: string; result: string; assertions?: string[] }> = [];
async function run(m: string[]): Promise<void> {
  const [name, file, old, replacement] = m;
  const id = name.split(" ")[0];
  const dir = mkdtempSync(join(tmpdir(), "human-wait-mutant-"));
  try {
    cpSync(root, dir, { recursive: true, filter: (src) => ![".git", "node_modules"].includes(basename(src)) });
    symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"));
    if (id !== "CONTROL") {
      const target = join(dir, file);
      const source = readFileSync(target, "utf8");
      const count = source.split(old).length - 1;
      if (count !== 1) throw new Error(`Mutation ${id} matches ${count} sites`);
      writeFileSync(target, source.replace(old, replacement));
    }
    const temp = join(dir, "tmp");
    mkdirSync(temp);
    let output = "";
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-name-pattern=child human wait reporting", "test/test.ts"], {
        cwd: dir, env: { ...process.env, TMPDIR: temp }, stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
      const timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 180000);
      child.stdout.on("data", (s) => { output += s; });
      child.stderr.on("data", (s) => { output += s; });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      child.once("exit", (c) => { clearTimeout(timer); done(c); });
    });
    writeFileSync(join(out, `${id}.log`), output);
    const assertions = output.split("\n").filter((s) => /AssertionError|error:|✖/.test(s)).slice(-24);
    const result = code === 0 ? (id === "CONTROL" ? "CONTROL_PASS" : "SURVIVED") : code === null ? "TIMED_OUT" : assertions.some((s) => /AssertionError|error:/.test(s)) ? "CAUGHT" : "INVALID_FAILURE";
    results.push({ name, result, assertions });
    console.log(`${id} ${result}`);
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
await run(["CONTROL unmutated copy", "", "", ""]);
if (results[0]?.result !== "CONTROL_PASS") throw new Error("Unmutated copy failed, mutation results would be invalid");
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await run(queue.shift()!);
}));
const summary = results.reduce<Record<string, number>>((a, r) => { a[r.result] = (a[r.result] ?? 0) + 1; return a; }, {});
console.log(JSON.stringify(summary));
if (results.some((r) => r.result !== "CAUGHT" && r.result !== "CONTROL_PASS")) process.exitCode = 1;
