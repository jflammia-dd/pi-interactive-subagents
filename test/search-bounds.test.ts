// search-bounds.test.ts: bounded grep and find for subagent children
// (UEBA recap retro, 2026-11-09). A restricted source-fetch child ran the
// built-in grep over the whole home directory for a token it already held in a
// supplied file and hung for about 19 minutes. These tests pin the dispatch
// roots, the exact whole-home call, supplied-file searches, explicit wider
// grants, symlink and traversal escapes and the finite deadline against the
// real built-in tool definitions. Every path lives under a temp fake home.
import "./isolate-agent-dir.ts";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createFindToolDefinition, createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_ROOTS,
  SEARCH_ROOTS_ENV,
  boundSearchTool,
  checkSearchPath,
  computeSearchRoots,
  decodeSearchRoots,
  encodeSearchRoots,
  extractTaskPaths,
  isBroadRoot,
  registerSearchBounds,
  resumeSearchRoots,
  searchTimeoutMs,
} from "../pi-extension/subagents/search-bounds.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "search-bounds-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "Users", "someone");
const vault = path.join(home, "Documents", "Vault");
const skillRef = path.join(home, "dotfiles", "skills", "recap", "references", "notes-doc-parsing.md");
const download = path.join(home, "Downloads", "UEBA Weekly Sync.md");
const outside = path.join(home, "Library", "Caches", "secret.txt");
for (const f of [skillRef, download, outside, path.join(vault, "note.md")]) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "line one\nSYNTHETIC-OWNER-TOKEN-0001 appears here\n");
}
const scratch = path.join(base, "scratch");
fs.mkdirSync(scratch);

// Synthetic copy of the incident's dispatch shape: supplied skill reference,
// a Downloads path with spaces and a scratch directory, cwd in the vault.
const TASK =
  `Read ${skillRef} and REFERENCE.md. Local Zoom AI summary at ${home}/Downloads/UEBA Weekly Sync.md has mistakes. ` +
  `Save raw response to ${scratch}/notes_doc.json and https://docs.example.com/a/b is a link. Do not overwrite ~/Documents/Vault/note.md.`;
const roots = computeSearchRoots({ cwd: vault, task: TASK, home, tmpdir: scratch });
const INCIDENT = { pattern: "SYNTHETIC-OWNER-TOKEN-0001", path: home, limit: 20 };

describe("dispatch search roots", () => {
  it("extracts supplied absolute and ~ paths but not URLs", () => {
    const paths = extractTaskPaths(TASK);
    assert.ok(paths.includes(skillRef));
    assert.ok(paths.includes(`${home}/Downloads/UEBA`), "a path with spaces truncates at the space");
    assert.ok(paths.includes("~/Documents/Vault/note.md"));
    assert.ok(!paths.some((p) => p.includes("docs.example.com")), "URLs are not paths");
  });

  it("roots cover cwd, temp and supplied files, never home or its ancestors", () => {
    assert.ok(roots.includes(vault));
    assert.ok(roots.includes(skillRef) && roots.includes(path.dirname(skillRef)));
    assert.ok(roots.includes(path.join(home, "Downloads")), "a truncated supplied path bounds to its directory");
    assert.ok(roots.includes(scratch));
    for (const broad of [home, path.dirname(home), "/"]) assert.ok(!roots.includes(broad), broad);
  });

  it("cwd at home or a top-level directory is never an implicit root", () => {
    const r = computeSearchRoots({ cwd: home, task: "", home, tmpdir: scratch });
    assert.ok(!r.includes(home));
    assert.ok(isBroadRoot("/opt", home) && isBroadRoot("/", home) && isBroadRoot(path.dirname(home), home));
    assert.ok(!isBroadRoot(vault, home));
  });

  it("a file supplied directly in home adds only the file", () => {
    const f = path.join(home, "top.md");
    fs.writeFileSync(f, "x");
    const r = computeSearchRoots({ cwd: vault, task: `see ${f}`, home, tmpdir: scratch });
    assert.ok(r.includes(f) && !r.includes(home));
  });

  it("explicit grants may be broad and come first", () => {
    const r = computeSearchRoots({ cwd: vault, task: "", explicit: ["~"], home, tmpdir: scratch });
    assert.equal(r[0], home);
  });

  it("the temp directory is always a root, so the list is never empty", () => {
    // On Linux os.tmpdir() is /tmp, a top-level directory that isBroadRoot would skip. With cwd at
    // home and no task paths the list used to come out empty and the child got no bound at all.
    // macOS resolves /tmp to /private/tmp, which is not top level, so use a directory that is.
    const topLevel = ["/opt", "/usr", "/var"].find((d) => fs.existsSync(d) && isBroadRoot(fs.realpathSync(d), home));
    assert.ok(topLevel, "this machine has a top-level directory to stand in for Linux /tmp");
    const tmp = fs.realpathSync(topLevel!);
    const r = computeSearchRoots({ cwd: home, task: "", home, tmpdir: topLevel });
    assert.ok(r.length > 0);
    assert.ok(r.includes(tmp), `expected ${tmp} in ${JSON.stringify(r)}`);
    assert.ok(!r.includes(home) && !r.includes("/"));
  });

  it("hostile task text stays bounded and the cap is reached by real directories", () => {
    const dirs = Array.from({ length: MAX_ROOTS + 36 }, (_, i) => path.join(base, "many", `d${i}`, "sub"));
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    const capped = computeSearchRoots({ cwd: vault, task: dirs.join(" "), home, tmpdir: scratch });
    assert.equal(capped.length, MAX_ROOTS, "a task naming more real directories than the cap is cut at the cap");
    const many = Array.from({ length: 500 }, (_, i) => `/p${i}/x`).join(" ");
    assert.ok(computeSearchRoots({ cwd: vault, task: many + " " + "/" + "a".repeat(10000), home, tmpdir: scratch }).length <= MAX_ROOTS);
    assert.ok(extractTaskPaths("/" + "a".repeat(5000)).length === 0);
    assert.deepEqual(extractTaskPaths(""), []);
  });

  it("environment encoding round-trips, an unset variable is open and an unusable one fails closed", () => {
    assert.deepEqual(decodeSearchRoots(encodeSearchRoots(roots)), roots);
    // Unset means an older launcher or a top-level session, so there is no bound to enforce.
    assert.equal(decodeSearchRoots(undefined), undefined);
    // A set value that cannot be used must not silently turn the bound off. An empty list denies
    // every search.
    for (const bad of ["", "nope", "{}", '{"v":2,"roots":["/a"]}', '{"v":1,"roots":"x"}', '{"v":1,"roots":["rel/path"]}', '{"v":1,"roots":[]}']) {
      assert.deepEqual(decodeSearchRoots(bad), [], String(bad));
    }
  });

  it("deadline parsing clamps", () => {
    assert.equal(searchTimeoutMs(undefined), DEFAULT_SEARCH_TIMEOUT_MS);
    assert.equal(searchTimeoutMs("abc"), DEFAULT_SEARCH_TIMEOUT_MS);
    assert.equal(searchTimeoutMs("5"), 1000);
    assert.equal(searchTimeoutMs("99999999999"), 30 * 60_000);
  });
});

describe("search path check", () => {
  it("RED/GREEN: the exact unrequested whole-home grep is refused with a remedy", () => {
    const v = checkSearchPath("grep", INCIDENT.path, vault, roots, home);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /outside this dispatch's search roots/);
    assert.match((v as { reason: string }).reason, /searchRoots/);
    for (const p of ["~", "/", "..", "../..", outside, path.join(vault, "..", "..", "Library")]) {
      assert.equal(checkSearchPath("grep", p, vault, roots, home).ok, false, p);
    }
  });

  it("supplied files, their directories, cwd and scratch are searchable", () => {
    for (const p of [skillRef, path.dirname(skillRef), download, undefined, ".", "note.md", scratch, "~/Documents/Vault"]) {
      assert.equal(checkSearchPath("grep", p, vault, roots, home).ok, true, String(p));
    }
  });

  it("a symlink inside a root that points outside is refused", () => {
    const link = path.join(vault, "escape");
    fs.symlinkSync(path.dirname(outside), link);
    assert.equal(checkSearchPath("grep", link, vault, roots, home).ok, false);
  });

  it("an overlong path is refused without filesystem work", () => {
    assert.equal(checkSearchPath("find", "/" + "a".repeat(5000), vault, roots, home).ok, false);
  });
});

describe("bounded built-in tools", () => {
  const grep = boundSearchTool(createGrepToolDefinition(vault), roots, 5000, home);
  const find = boundSearchTool(createFindToolDefinition(vault), roots, 5000, home);
  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

  it("keeps the built-in identity and does not self-activate", () => {
    assert.equal(grep.name, "grep");
    assert.equal(find.name, "find");
    assert.equal((grep as { defaultActive?: boolean }).defaultActive, false);
    assert.deepEqual(grep.parameters, createGrepToolDefinition(vault).parameters);
  });

  it("refuses the incident call before ripgrep starts", async () => {
    await assert.rejects(grep.execute("t", INCIDENT as never, undefined, undefined, { cwd: vault } as never), /outside this dispatch's search roots/);
    await assert.rejects(find.execute("t", { pattern: "*.md", path: home } as never, undefined, undefined, { cwd: vault } as never), /outside/);
  });

  it("searches a supplied file and finds the token", async () => {
    const r = await grep.execute("t", { pattern: "SYNTHETIC-OWNER-TOKEN-0001", path: skillRef } as never, undefined, undefined, { cwd: vault } as never);
    assert.match(text(r as never), /SYNTHETIC-OWNER-TOKEN-0001 appears here/);
    const f = await find.execute("t", { pattern: "*.md", path: vault } as never, undefined, undefined, { cwd: vault } as never);
    assert.match(text(f as never), /note\.md/);
  });

  it("an explicit home grant authorizes the wider search", async () => {
    const wide = boundSearchTool(createGrepToolDefinition(vault), [home], 5000, home);
    const r = await wide.execute("t", INCIDENT as never, undefined, undefined, { cwd: vault } as never);
    assert.match(text(r as never), /SYNTHETIC-OWNER-TOKEN-0001/);
  });

  it("a search that never finishes stops at its deadline and leaves no ripgrep behind", async () => {
    const fifo = path.join(scratch, "stuck.fifo");
    execFileSync("mkfifo", [fifo]);
    const short = boundSearchTool(createGrepToolDefinition(vault), roots, 1000, home);
    const start = Date.now();
    await assert.rejects(short.execute("t", { pattern: "x", path: fifo } as never, undefined, undefined, { cwd: vault } as never),
      /stopped at its 1 s search deadline/);
    assert.ok(Date.now() - start < 5000, "the deadline must bound the call");
    await new Promise((r) => setTimeout(r, 200));
    const ps = execFileSync("ps", ["-axo", "command"]).toString();
    assert.ok(!ps.split("\n").some((l) => l.includes(fifo)), "no ripgrep process on the fifo remains");
  });

  it("a caller abort keeps its own error instead of the deadline message", async () => {
    const fake = { ...createGrepToolDefinition(vault),
      execute: (_i: string, _p: unknown, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("Operation aborted")))) };
    const bounded = boundSearchTool(fake as never, roots, 60_000, home);
    const ac = new AbortController();
    const p = bounded.execute("t", { pattern: "x", path: vault } as never, ac.signal, undefined, { cwd: vault } as never);
    ac.abort();
    await assert.rejects(p, /^Error: Operation aborted$/);
  });

  it("an empty root list refuses every search and names the variable", async () => {
    const closed = boundSearchTool(createGrepToolDefinition(vault), [], 5000, home);
    await assert.rejects(
      () => closed.execute("t", { pattern: "x", path: vault } as never, undefined, undefined, { cwd: vault } as never),
      /PI_SUBAGENT_SEARCH_ROOTS/,
    );
  });

  it("no roots variable means no root check, still bounded by the deadline", async () => {
    const open = boundSearchTool(createGrepToolDefinition(vault), undefined, 5000, home);
    const r = await open.execute("t", { pattern: "SYNTHETIC-OWNER-TOKEN-0001", path: outside } as never, undefined, undefined, { cwd: vault } as never);
    assert.match(text(r as never), /appears here/);
  });
});

describe("child registration", () => {
  it("registers bounded grep and find from the environment", async () => {
    const tools: any[] = [];
    registerSearchBounds({ registerTool: (t) => tools.push(t) }, { [SEARCH_ROOTS_ENV]: encodeSearchRoots(roots) } as never);
    assert.deepEqual(tools.map((t) => t.name).sort(), ["find", "grep"]);
    assert.ok(tools.every((t) => t.defaultActive === false));
  });

  it("a set but unusable roots variable registers tools that refuse every search", async () => {
    for (const bad of ["", "garbage", '{"v":1,"roots":[]}']) {
      const tools: any[] = [];
      registerSearchBounds({ registerTool: (t) => tools.push(t) }, { [SEARCH_ROOTS_ENV]: bad } as never);
      const grepTool = tools.find((t) => t.name === "grep");
      await assert.rejects(
        () => grepTool.execute("t", { pattern: "x", path: vault }, undefined, undefined, { cwd: vault }),
        /PI_SUBAGENT_SEARCH_ROOTS/,
        JSON.stringify(bad),
      );
    }
  });
});

// ── Round 1 review: resolve exactly as native grep and find do ──
// Native tools resolve their path with resolveToCwd (dist/core/tools/path-utils.js),
// which is resolvePath(input, cwd, { normalizeUnicodeSpaces, stripAtPrefix })
// from dist/utils/paths.js. That module is not a package export, so the test
// imports it by absolute path and the runtime keeps a vendored copy.
import { pathToFileURL as toUrl } from "node:url";
import { resolveLikeNativeSearch } from "../pi-extension/subagents/search-bounds.ts";
const SDK = path.dirname(path.dirname(fs.realpathSync(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname)));
const nativePaths = await import(toUrl(path.join(SDK, "dist", "utils", "paths.js")).href) as {
  resolvePath: (input: string, base?: string, opts?: Record<string, unknown>) => string;
};
const nativeResolve = (input: string, cwd: string) => nativePaths.resolvePath(input || ".", cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });

describe("native path parity", () => {
  const pcwd = path.join(base, "parity", "cwd");
  const other = path.join(base, "parity", "other", "leaf2");
  const spaced = path.join(pcwd, "sp ace");
  for (const d of [path.join(pcwd, "leaf"), other, spaced]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "m.txt"), `MARK:${d}\n`);
  }
  const fileUrl = toUrl(other).href;
  const encodedUp = `file://${pcwd}/%2e%2e/other/leaf2`;
  const inputs = ["", ".", "leaf", "./leaf", "@leaf", " leaf", "leaf ", "sp\u00A0ace", "sp\u2003ace", "@sp\u202Face",
    fileUrl, `@${fileUrl}`, encodedUp, "~", "~/x", "@~/x", "~user/x", "../other/leaf2", "/abs/../x", "file:relative", "http://h/x"];

  it("vendored resolution equals the installed SDK for every input", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const input of inputs) assert.equal(resolveLikeNativeSearch(input, pcwd), nativeResolve(input, pcwd), JSON.stringify(input));
    } finally { process.env.HOME = savedHome; }
  });

  it("black box: the native grep tool searches exactly the path the check authorizes", async () => {
    const native = createGrepToolDefinition(pcwd);
    for (const input of ["leaf", "@leaf", "./leaf", "sp\u00A0ace", fileUrl, `@${fileUrl}`, encodedUp]) {
      const r = await native.execute("t", { pattern: "MARK:", path: input } as never, undefined, undefined, { cwd: pcwd } as never);
      const found = [...JSON.stringify(r.content).matchAll(/MARK:([^\\"]+)/g)].map((m) => m[1]);
      assert.deepEqual(found, [resolveLikeNativeSearch(input, pcwd)], JSON.stringify(input));
    }
  });

  it("RED/GREEN: file URLs, @ prefixes, Unicode spaces and encoded traversal cannot reach outside roots", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const p of [toUrl(home).href, `@${toUrl(home).href}`, `file://${vault}/%2e%2e/%2e%2e`, `@file://${vault}/%2e%2e/%2e%2e/Library`,
        `${home}\u00A0`.slice(0, -1), "file://localhost" + home, `@~`, "@" + outside]) {
        assert.equal(checkSearchPath("grep", p, vault, roots, home).ok, false, p);
      }
      for (const p of ["file://remote-host/etc", "file:///tmp/%2Fescape"]) {
        const v = checkSearchPath("grep", p, vault, roots, home);
        assert.equal(v.ok, false, p);
      }
      assert.equal(checkSearchPath("grep", toUrl(skillRef).href, vault, roots, home).ok, true, "a file URL to a supplied file is allowed");
      assert.equal(checkSearchPath("grep", `@${skillRef}`, vault, roots, home).ok, true);
    } finally { process.env.HOME = savedHome; }
  });
});

// ── Round 1 review: a bounded child cannot widen a grandchild ──
import { narrowToInherited } from "../pi-extension/subagents/search-bounds.ts";

describe("inherited roots", () => {
  const parentRoots = [vault, scratch];

  it("RED/GREEN: explicit grants and implicit task paths outside the inherited roots are dropped", () => {
    const computed = computeSearchRoots({ cwd: vault, task: `read ${skillRef}`, explicit: ["~"], home, tmpdir: scratch });
    const r = narrowToInherited(computed, parentRoots, {});
    assert.ok(!r.roots.includes(home), "no explicit home grant");
    assert.ok(!r.roots.includes(skillRef) && !r.roots.includes(path.dirname(skillRef)), "no task path outside the parent's roots");
    assert.ok(r.roots.includes(vault) && r.roots.includes(scratch));
    assert.ok(r.dropped.includes(home) && r.dropped.includes(skillRef));
    for (const root of r.roots) assert.ok(parentRoots.some((p) => root === p || root.startsWith(p + path.sep)), root);
  });

  it("a subdirectory grant inside the inherited roots is kept", () => {
    const sub = path.join(vault, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const r = narrowToInherited([sub, path.join(vault, "note.md")], parentRoots, {});
    assert.deepEqual(r.roots, [sub, path.join(vault, "note.md")]);
    assert.deepEqual(r.dropped, []);
  });

  it("a symlink inside the inherited roots that points outside is dropped", () => {
    const link = path.join(scratch, "to-library");
    if (!fs.existsSync(link)) fs.symlinkSync(path.dirname(outside), link);
    const r = narrowToInherited(computeSearchRoots({ cwd: vault, task: "", explicit: [link], home, tmpdir: scratch }), parentRoots, {});
    assert.ok(!r.roots.includes(path.dirname(outside)), JSON.stringify(r));
  });

  it("a worktree of a repo inside the inherited roots stays searchable", () => {
    const wt = path.join(base, "repo-root", ".pi", "worktrees", "x-1");
    fs.mkdirSync(wt, { recursive: true });
    const r = narrowToInherited([wt, vault], parentRoots, { worktreePath: wt, worktreeSource: vault });
    assert.ok(r.roots.includes(wt));
    const denied = narrowToInherited([wt], parentRoots, { worktreePath: wt, worktreeSource: path.join(base, "elsewhere") });
    assert.ok(!denied.roots.includes(wt), "a worktree of a repo outside the inherited roots is not added");
  });

  it("everything dropped falls back to the inherited roots, never wider", () => {
    const r = narrowToInherited([home], parentRoots, {});
    assert.deepEqual(r.roots, parentRoots);
  });

  it("resume keeps the stored roots, narrowed to the resumer's own bound", () => {
    assert.deepEqual(resumeSearchRoots([vault, scratch], undefined, vault), [vault, scratch]);
    assert.deepEqual(resumeSearchRoots([vault, scratch], [vault], vault), [vault]);
  });

  it("resume ignores corrupt stored entries instead of throwing", () => {
    const stored = [1, null, "rel/path", { x: 1 }, vault] as unknown as string[];
    assert.deepEqual(resumeSearchRoots(stored, undefined, vault), [vault]);
    assert.deepEqual(resumeSearchRoots([1, null] as unknown as string[], undefined, vault), []);
  });

  it("resume of a snapshot written before search bounds existed is still bounded", () => {
    // No stored roots and an unbounded resumer used to relaunch the child with no bound at all.
    const fresh = resumeSearchRoots(undefined, undefined, vault);
    assert.ok(fresh.length > 0 && fresh.includes(vault), JSON.stringify(fresh));
    assert.ok(!fresh.includes(home) && !fresh.includes("/"));
    assert.deepEqual(resumeSearchRoots(null, undefined, vault), fresh);
    // A bounded resumer passes on exactly its own roots.
    assert.deepEqual(resumeSearchRoots(undefined, [scratch], vault), [scratch]);
    assert.deepEqual(resumeSearchRoots(null, [scratch], vault), [scratch]);
  });

  it("an empty inherited list is a bound that allows nothing, so everything computed is dropped", () => {
    const r = narrowToInherited([vault, scratch], [], {});
    assert.deepEqual(r.roots, []);
    assert.deepEqual(r.dropped, [vault, scratch]);
  });

  it("no inherited roots leaves the computed roots unchanged", () => {
    assert.deepEqual(narrowToInherited([home, vault], undefined, {}), { roots: [home, vault], dropped: [] });
  });
});
