/**
 * search-bounds.ts: bounded filesystem search for subagent children.
 *
 * Problem (UEBA recap retro, 2026-11-09): a restricted source-fetch child ran
 * the built-in grep tool over the whole home directory for a token it already
 * held in a supplied file. The built-in grep has no deadline and a zero-match
 * pattern never reaches its match limit, so the call ran for about 19 minutes
 * until the user interrupted it.
 *
 * Pi has no native per-dispatch path permission, so the bound is enforced
 * where the child executes. Two halves:
 *
 *   Parent (launch and resume): computeSearchRoots() derives explicit search
 *   roots for the dispatch and the launcher passes them to the child in
 *   PI_SUBAGENT_SEARCH_ROOTS, persisted in the loadout snapshot for resume.
 *   Roots are the child's cwd, the temp directory, every absolute or ~ path
 *   the task text supplies (the file itself and its directory) and any
 *   explicit `searchRoots` the dispatcher grants. Implicit roots never widen to
 *   `/`, the home directory, an ancestor of it or a top-level directory. Only
 *   an explicit grant can authorize that broader discovery.
 *
 *   Child (subagent-done.ts, loaded in every pi child): registerSearchBounds()
 *   overrides the built-in grep and find tools with the official
 *   spread-and-delegate pattern (examples/extensions/tool-override.ts). Each
 *   call is checked against the roots and runs under a finite deadline
 *   (PI_SUBAGENT_SEARCH_TIMEOUT_MS, default 60 s) that aborts the search
 *   process. Model calls and codemode nested calls both run this execute.
 *
 * Polarity: a path outside the roots is rejected with a message naming the
 * roots and the remedy. A missing or unreadable roots variable means no root
 * check (an older launcher), never a blanket block, and the deadline still
 * applies. The override keeps defaultActive: false so it activates only where
 * grep or find was already selected.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createFindToolDefinition, createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

export const SEARCH_ROOTS_ENV = "PI_SUBAGENT_SEARCH_ROOTS";
export const SEARCH_TIMEOUT_ENV = "PI_SUBAGENT_SEARCH_TIMEOUT_MS";
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
export const MAX_ROOTS = 64;
const MAX_PATH_CHARS = 4096;
const MAX_TASK_SCAN_CHARS = 256 * 1024;
const MAX_TASK_PATHS = 200;

export interface SearchRootsInput {
  cwd: string;
  task?: string;
  explicit?: readonly string[];
  home?: string;
  tmpdir?: string;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Vendored copy of Pi's normalizePath (dist/utils/paths.js, Pi 1.5.0) for the
 * POSIX platforms this fork runs on. That module is not a package export, so
 * it cannot be imported safely at runtime. test/search-bounds.test.ts compares
 * this copy with the installed SDK for a table of inputs and runs the native
 * grep tool as a black box, so any drift fails the suite. Throws like the
 * native code on an invalid file URL. Pure apart from os.homedir().
 */
export function normalizeLikeNative(input: string, opts: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean; home?: string } = {}): string {
  let normalized = input;
  if (opts.normalizeUnicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, " ");
  if (opts.stripAtPrefix && normalized.startsWith("@")) normalized = normalized.slice(1);
  const home = opts.home ?? os.homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/")) return path.join(home, normalized.slice(2));
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/**
 * Resolve a grep or find `path` argument exactly as the native tools do:
 * resolveToCwd(searchDir || ".", cwd), which is resolvePath with Unicode-space
 * normalization and @ stripping. No trimming, like the native code.
 */
export function resolveLikeNativeSearch(raw: string | undefined, cwd: string, home = os.homedir()): string {
  const normalized = normalizeLikeNative(raw || ".", { normalizeUnicodeSpaces: true, stripAtPrefix: true, home });
  const base = normalizeLikeNative(cwd, { home });
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(base, normalized);
}

/** Former name, kept for callers. Same resolution as the native tools. */
export const resolveUserPath = (raw: string, cwd: string, home = os.homedir()): string => resolveLikeNativeSearch(raw, cwd, home);

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
export function realOrNearest(p: string): { real: string; exists: boolean; isFile: boolean } {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      const st = fs.statSync(real);
      if (rest.length === 0) return { real, exists: true, isFile: st.isFile() };
      return { real: path.join(real, ...rest.reverse()), exists: false, isFile: false };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { real: path.resolve(p), exists: false, isFile: false };
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function realHome(home: string): string {
  try { return fs.realpathSync(home); } catch { return path.resolve(home); }
}

/** `/`, the home directory, an ancestor of it or a top-level directory. Pure. */
export function isBroadRoot(p: string, home = os.homedir()): boolean {
  const h = realHome(home);
  const n = path.resolve(p);
  if (n === path.parse(n).root) return true;
  if (n === h || h.startsWith(n.endsWith(path.sep) ? n : n + path.sep)) return true;
  return n.split(path.sep).filter(Boolean).length < 2;
}

/** Absolute and ~ paths a task text supplies, in order of first mention. Pure. */
export function extractTaskPaths(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s"'`(\[<=,])((?:~\/|\/)[^\s"'`)\]>,]+)/g;
  for (const m of task.slice(0, MAX_TASK_SCAN_CHARS).matchAll(re)) {
    let p = m[1];
    if (p.startsWith("//")) continue;
    p = p.replace(/\\+$/, "").replace(/[.:;!?]+$/, "");
    if (p.length < 2 || p.length > MAX_PATH_CHARS || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_TASK_PATHS) break;
  }
  return out;
}

/**
 * Explicit search roots for one dispatch. Explicit grants come first and may
 * be broad. Implicit roots (cwd, temp, task paths) never are. Real paths,
 * deduplicated and capped at MAX_ROOTS.
 */
export function computeSearchRoots(input: SearchRootsInput): string[] {
  const home = input.home ?? os.homedir();
  const roots: string[] = [];
  const add = (p: string) => { if (!roots.includes(p) && roots.length < MAX_ROOTS) roots.push(p); };

  for (const raw of input.explicit ?? []) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_PATH_CHARS) continue;
    let resolved: string;
    try { resolved = resolveLikeNativeSearch(raw, input.cwd, home); } catch { continue; }
    add(realOrNearest(resolved).real);
  }
  // The temp directories are always allowed, even when one is a top-level directory such as
  // /tmp on Linux, so the list is never empty and every child gets a bound.
  const tempDirs = new Set([input.tmpdir ?? os.tmpdir(), "/tmp"]);
  const implicit = [input.cwd, ...tempDirs, ...extractTaskPaths(input.task ?? "")];
  const h = realHome(home);
  for (const raw of implicit) {
    let resolved: string;
    try { resolved = resolveLikeNativeSearch(raw, input.cwd, home); } catch { continue; }
    const r = realOrNearest(resolved);
    if (tempDirs.has(raw) && r.exists && !r.isFile) {
      const isFsRoot = r.real === path.parse(r.real).root;
      if (!isFsRoot && r.real !== h && !within(h, r.real)) {
        add(r.real);
        continue;
      }
    }
    // A supplied path that does not exist (a truncated path with spaces, or a
    // file the child will create) bounds to its nearest existing directory.
    const target = r.exists ? r.real : path.dirname(r.real);
    const nearest = r.exists ? r : realOrNearest(target);
    if (nearest.isFile) {
      add(nearest.real);
      const dir = path.dirname(nearest.real);
      if (!isBroadRoot(dir, home)) add(dir);
    } else if (!isBroadRoot(nearest.real, home)) {
      add(nearest.real);
    }
  }
  return roots;
}

/** Serialize roots for the child environment. Pure. */
export function encodeSearchRoots(roots: readonly string[]): string {
  return JSON.stringify({ v: 1, roots: roots.slice(0, MAX_ROOTS) });
}

/**
 * Parse the child environment value. Undefined means the variable is unset, so there is no bound
 * to enforce (a top-level session or an older launcher). A value that is set but unusable returns
 * an empty list, which allows no search at all, so a launcher bug cannot silently remove the bound. Pure.
 */
export function decodeSearchRoots(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; roots?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.roots)) return [];
    const roots = parsed.roots.filter((r): r is string => typeof r === "string" && path.isAbsolute(r) && r.length <= MAX_PATH_CHARS);
    return roots.slice(0, MAX_ROOTS);
  } catch {
    return [];
  }
}

/** Deadline in ms from the environment, clamped. Pure. */
export function searchTimeoutMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/**
 * Narrow a grandchild's computed roots to the roots its launcher was bounded
 * to (PI_SUBAGENT_SEARCH_ROOTS in the launching process). Explicit grants and
 * implicit task paths outside the inherited roots are dropped and reported.
 * A worktree the launcher creates stays searchable when its source checkout is
 * inside the inherited roots, because it holds the same files. When nothing
 * survives, the inherited roots themselves are used, never anything wider.
 * Without inherited roots (a top-level session) nothing changes.
 */
export function narrowToInherited(
  computed: readonly string[],
  inherited: readonly string[] | undefined,
  opts: { worktreePath?: string; worktreeSource?: string },
): { roots: string[]; dropped: string[] } {
  if (!inherited) return { roots: [...computed], dropped: [] };
  const parents = inherited.map((r) => realOrNearest(r).real);
  const inside = (p: string) => parents.some((r) => within(realOrNearest(p).real, r));
  const roots: string[] = [];
  const dropped: string[] = [];
  const worktreeOk = !!opts.worktreePath && !!opts.worktreeSource && inside(opts.worktreeSource);
  for (const r of computed) {
    const allowed = inside(r) || (worktreeOk && realOrNearest(r).real === realOrNearest(opts.worktreePath!).real);
    if (allowed) { if (!roots.includes(r)) roots.push(r); } else if (!dropped.includes(r)) dropped.push(r);
  }
  if (worktreeOk && !roots.includes(opts.worktreePath!)) roots.push(opts.worktreePath!);
  return { roots: roots.length > 0 ? roots.slice(0, MAX_ROOTS) : [...inherited], dropped };
}

/**
 * Roots for a resumed child. A snapshot with stored roots replays them, narrowed to the resumer's
 * own bound. A snapshot written before search bounds existed has none, so the child gets the
 * resumer's inherited roots or, for a top-level resumer, roots computed from the fallback cwd.
 * A resumed child is never left unbounded.
 */
export function resumeSearchRoots(
  stored: readonly string[] | null | undefined,
  inherited: readonly string[] | undefined,
  fallbackCwd: string,
): string[] {
  if (Array.isArray(stored)) {
    // A hand-edited or corrupt snapshot can hold anything. Keep only absolute path strings.
    const usable = stored.filter((r): r is string => typeof r === "string" && path.isAbsolute(r) && r.length <= MAX_PATH_CHARS);
    return narrowToInherited(usable, inherited, {}).roots;
  }
  return inherited ? [...inherited] : computeSearchRoots({ cwd: fallbackCwd, task: "" });
}

function within(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

export type SearchVerdict = { ok: true; target: string } | { ok: false; target: string; reason: string };

/** Check one search path against the dispatch roots. Symlinks resolve first. */
export function checkSearchPath(tool: string, rawPath: string | undefined, cwd: string, roots: readonly string[], home = os.homedir()): SearchVerdict {
  const requested = typeof rawPath === "string" ? rawPath : "";
  if (roots.length === 0) {
    return {
      ok: false,
      target: requested.slice(0, 80),
      reason:
        `${tool} refused: this child's search roots (${SEARCH_ROOTS_ENV}) are empty or unusable, so no path can be searched. ` +
        `Report this to the dispatcher.`,
    };
  }
  if (requested.length > MAX_PATH_CHARS) {
    return { ok: false, target: requested.slice(0, 80), reason: `${tool} path is longer than ${MAX_PATH_CHARS} characters.` };
  }
  let resolved: string;
  try {
    resolved = resolveLikeNativeSearch(requested, cwd, home);
  } catch (error) {
    return { ok: false, target: requested.slice(0, 200), reason: `${tool} refused: ${JSON.stringify(requested.slice(0, 200))} is not a usable local path (${(error as Error).message}).` };
  }
  const target = realOrNearest(resolved).real;
  const realRoots = roots.map((r) => realOrNearest(r).real);
  if (realRoots.some((r) => within(target, r))) return { ok: true, target };
  const shown = realRoots.slice(0, 12).join(", ") + (realRoots.length > 12 ? `, and ${realRoots.length - 12} more` : "");
  return {
    ok: false,
    target,
    reason:
      `${tool} refused: ${target} is outside this dispatch's search roots (${shown}). ` +
      `Search the supplied files or their directories instead. ` +
      `If wider discovery is really needed, report that to the dispatcher, which can grant it with searchRoots.`,
  };
}

type SearchToolDefinition = ReturnType<typeof createGrepToolDefinition> | ReturnType<typeof createFindToolDefinition>;

/** Wrap one built-in search tool with the root check and the deadline. */
export function boundSearchTool<T extends SearchToolDefinition>(base: T, roots: readonly string[] | undefined, timeoutMs: number, home = os.homedir()): T {
  const execute = base.execute as (...args: any[]) => Promise<any>;
  return {
    ...base,
    defaultActive: false,
    async execute(toolCallId: string, params: { path?: string }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd?: string } | undefined) {
      const cwd = ctx?.cwd ?? process.cwd();
      let target = params?.path ?? ".";
      if (roots) {
        const verdict = checkSearchPath(base.name, params?.path, cwd, roots, home);
        if (!verdict.ok) throw new Error(verdict.reason);
        target = verdict.target;
      }
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        return await execute(toolCallId, params, combined, onUpdate, ctx);
      } catch (error) {
        if (deadline.aborted && !signal?.aborted) {
          throw new Error(
            `${base.name} stopped at its ${Math.round(timeoutMs / 1000)} s search deadline in ${target}. ` +
            `Narrow the path or pattern, or search a supplied file directly.`,
          );
        }
        throw error;
      }
    },
  } as T;
}

/** Child-side registration. Called from subagent-done.ts in every pi child. */
export function registerSearchBounds(pi: { registerTool: (tool: any) => void }, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const roots = decodeSearchRoots(env[SEARCH_ROOTS_ENV]);
    const timeoutMs = searchTimeoutMs(env[SEARCH_TIMEOUT_ENV]);
    const cwd = process.cwd();
    pi.registerTool(boundSearchTool(createGrepToolDefinition(cwd), roots, timeoutMs));
    pi.registerTool(boundSearchTool(createFindToolDefinition(cwd), roots, timeoutMs));
  } catch (error) {
    // Registration failure leaves the built-in tools in place. Report it so a
    // missing bound is visible rather than silent.
    console.error(`[subagents] search bounds not registered: ${(error as Error).message}`);
  }
}


