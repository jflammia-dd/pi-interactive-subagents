// resume-cwd.test.ts: resuming a subagent whose recorded cwd is gone.
//
// A worktree subagent's checkout is removed when it finishes, so its session
// header still names a directory that no longer exists. Pi's interactive
// startup then stops at a "Session cwd does not exist" selector (Continue,
// Fork or Cancel) that nobody answers in a child pane, and the resumed
// subagent never starts. repointMissingSessionCwd rewrites only the header
// cwd to a directory that exists so the resume starts without a prompt.
import "./isolate-agent-dir.ts";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repointMissingSessionCwd } from "../pi-extension/subagents/session.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cwd-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MESSAGES = [
  JSON.stringify({ type: "message", id: "a1", parentId: null, message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
  JSON.stringify({ type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "done ✓ with unicode \u00e9" }] } }),
];

function writeSession(name: string, header: unknown | string, lines: string[] = MESSAGES): string {
  const file = path.join(tmp, name);
  const head = typeof header === "string" ? header : JSON.stringify(header);
  fs.writeFileSync(file, [head, ...lines].join("\n") + "\n");
  return file;
}

describe("repointMissingSessionCwd", () => {
  it("rewrites a missing header cwd and keeps every other byte", () => {
    const gone = path.join(tmp, "worktrees", "removed-checkout");
    const file = writeSession("missing.jsonl", { type: "session", version: 3, id: "s-1", timestamp: "2026-11-10T00:00:00.000Z", cwd: gone });
    const before = fs.readFileSync(file, "utf8").split("\n");
    const result = repointMissingSessionCwd(file, tmp);
    assert.deepEqual(result, { changed: true, from: gone, to: tmp });
    const after = fs.readFileSync(file, "utf8").split("\n");
    const header = JSON.parse(after[0]);
    assert.equal(header.cwd, tmp);
    assert.equal(header.id, "s-1");
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.timestamp, "2026-11-10T00:00:00.000Z");
    assert.deepEqual(after.slice(1), before.slice(1));
  });

  it("leaves a header whose cwd still exists untouched", () => {
    const file = writeSession("exists.jsonl", { type: "session", version: 3, id: "s-2", timestamp: "t", cwd: tmp });
    const before = fs.readFileSync(file);
    assert.deepEqual(repointMissingSessionCwd(file, path.join(tmp, "elsewhere")), { changed: false });
    assert.ok(fs.readFileSync(file).equals(before));
  });

  it("does nothing when the header is not a session header or has no cwd", () => {
    const noCwd = writeSession("nocwd.jsonl", { type: "session", version: 3, id: "s-3", timestamp: "t" });
    const notSession = writeSession("notsession.jsonl", { type: "message", id: "x", cwd: path.join(tmp, "gone") });
    for (const file of [noCwd, notSession]) {
      const before = fs.readFileSync(file);
      assert.deepEqual(repointMissingSessionCwd(file, tmp), { changed: false });
      assert.ok(fs.readFileSync(file).equals(before));
    }
  });

  it("does nothing for malformed, empty or missing files", () => {
    const bad = writeSession("bad.jsonl", "{not json");
    const empty = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(empty, "");
    for (const file of [bad, empty, path.join(tmp, "absent.jsonl")]) {
      assert.deepEqual(repointMissingSessionCwd(file, tmp), { changed: false });
    }
    assert.equal(fs.existsSync(path.join(tmp, "absent.jsonl")), false);
  });

  it("refuses a fallback cwd that does not exist", () => {
    const gone = path.join(tmp, "gone-a");
    const file = writeSession("badfallback.jsonl", { type: "session", version: 3, id: "s-4", timestamp: "t", cwd: gone });
    const before = fs.readFileSync(file);
    assert.deepEqual(repointMissingSessionCwd(file, path.join(tmp, "gone-b")), { changed: false });
    assert.ok(fs.readFileSync(file).equals(before));
  });

  it("handles a large transcript and leaves no temp file behind", () => {
    const gone = path.join(tmp, "gone-large");
    const many = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } }));
    const file = writeSession("large.jsonl", { type: "session", version: 3, id: "s-5", timestamp: "t", cwd: gone }, many);
    const tail = fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    assert.equal(repointMissingSessionCwd(file, tmp).changed, true);
    assert.equal(fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n"), tail);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes(".tmp")), []);
  });

  it("rewrites the file a symlink points at and keeps the symlink", () => {
    const gone = path.join(tmp, "gone-link");
    const target = writeSession("link-target.jsonl", { type: "session", version: 3, id: "s-7", timestamp: "t", cwd: gone });
    const link = path.join(tmp, "link.jsonl");
    fs.symlinkSync(target, link);
    assert.equal(repointMissingSessionCwd(link, tmp).changed, true);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link is still a link");
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8").split("\n")[0]).cwd, tmp);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes(".tmp")), []);
  });

  it("keeps a group-writable mode that the umask would otherwise strip", () => {
    const gone = path.join(tmp, "gone-umask");
    const file = writeSession("umask.jsonl", { type: "session", version: 3, id: "s-8", timestamp: "t", cwd: gone });
    fs.chmodSync(file, 0o664);
    const previous = process.umask(0o022);
    try {
      assert.equal(repointMissingSessionCwd(file, tmp).changed, true);
    } finally {
      process.umask(previous);
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o664);
  });

  it("gives up and keeps a line another process appended while it worked", () => {
    const gone = path.join(tmp, "gone-race");
    const file = writeSession("race.jsonl", { type: "session", version: 3, id: "s-9", timestamp: "t", cwd: gone });
    const appended = JSON.stringify({ type: "message", id: "late", parentId: "a2" });
    const result = repointMissingSessionCwd(file, tmp, { beforeRename: () => fs.appendFileSync(file, appended + "\n") });
    assert.deepEqual(result, { changed: false });
    const lines = fs.readFileSync(file, "utf8").split("\n");
    assert.equal(JSON.parse(lines[0]).cwd, gone, "the header is left as it was");
    assert.ok(lines.includes(appended), "the late append survives");
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes(".tmp")), []);
  });

  it("preserves the file mode", () => {
    const gone = path.join(tmp, "gone-mode");
    const file = writeSession("mode.jsonl", { type: "session", version: 3, id: "s-6", timestamp: "t", cwd: gone });
    fs.chmodSync(file, 0o600);
    assert.equal(repointMissingSessionCwd(file, tmp).changed, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
