// Child-local human waits use the existing activity directory and parent reporter.
// Advisory only: a failed read/write must never interrupt a prompt or its tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readRegularFile } from "./activity.ts";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const HUMAN_WAIT_LEASE_MS = 8_000;
const HEARTBEAT_MS = 1_000;
const MAX_DEPTH = 10_000;
const WAIT_KINDS = new Set(["select", "confirm", "input", "editor"]);

export interface HumanWaitState {
  version: 1;
  runningChildId: string;
  startedAt: number;
  pid: number;
  pane: string;
  name: string;
  herdrSession: string;
  count: number;
  updatedAt: number;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function cleanDeadWriterTemps(activityFile: string): void {
  try {
    const dir = dirname(activityFile);
    // Only this parent's wait-temp namespace, never another live writer's file.
    for (const file of readdirSync(dir)) {
      const match = /^[a-z0-9_-]{1,64}\.json\.wait\.(\d+)\.[a-f0-9-]{36}\.tmp$/i.exec(file);
      const pid = match ? Number(match[1]) : 0;
      if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) {
        try { unlinkSync(join(dir, file)); } catch {}
      }
    }
  } catch {}
}

/** A live process, matching launch identity and a renewed lease are all required. */
export function readHumanWait(
  activityFile: string,
  id: string,
  startedAt?: number,
  now = Date.now(),
  options: { deferExpiry?: boolean; allowDead?: boolean } = {},
): (HumanWaitState & { expired: boolean; alive: boolean }) | null {
  try {
    const file = `${activityFile}.wait`;
    const value = JSON.parse(readRegularFile(file, 4096));
    if (!value || value.version !== 1 || value.runningChildId !== id ||
        !/^[a-z0-9_-]{1,64}$/i.test(id) ||
        !Number.isFinite(value.startedAt) || value.startedAt <= 0 ||
        (startedAt !== undefined && value.startedAt !== startedAt) ||
        !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        typeof value.pane !== "string" || !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(value.pane) ||
        typeof value.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.name) ||
        value.herdrSession !== (process.env.HERDR_SESSION ?? "") ||
        !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_DEPTH ||
        !Number.isFinite(value.updatedAt) || value.updatedAt < value.startedAt ||
        value.updatedAt > now + HEARTBEAT_MS) return null;
    const alive = processAlive(value.pid);
    if (!alive && !options.allowDead) return null;
    // Give the child heartbeat one wake tick before judging a slept-through lease.
    const expired = !options.deferExpiry && now - value.updatedAt > HUMAN_WAIT_LEASE_MS;
    return { ...value, count: expired ? 0 : value.count, expired, alive };
  } catch { return null; }
}

export type HumanWaitOwner = Pick<HumanWaitState,
  "version" | "runningChildId" | "startedAt" | "pane" | "name" | "herdrSession">;

/** Parent-written launch identity, never derived from the child wait payload.
 * This removes sidecar-only forgery, not arbitrary same-user filesystem access.
 */
export function writeHumanWaitOwner(activityFile: string, owner: HumanWaitOwner): void {
  const file = `${activityFile}.owner`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}

export function readHumanWaitOwner(activityFile: string, id: string): HumanWaitOwner | null {
  try {
    const owner = JSON.parse(readRegularFile(`${activityFile}.owner`, 4096));
    if (owner?.version !== 1 || owner.runningChildId !== id || !/^[a-z0-9_-]{1,64}$/i.test(id) ||
        !Number.isFinite(owner.startedAt) || owner.startedAt <= 0 ||
        typeof owner.pane !== "string" || !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(owner.pane) ||
        typeof owner.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(owner.name) ||
        owner.herdrSession !== (process.env.HERDR_SESSION ?? "")) return null;
    return owner;
  } catch { return null; }
}

/** Always loaded by subagent-done. No hook authority or session reference in the child. */
export function registerHumanWait(pi: ExtensionAPI): void {
  let state: HumanWaitState | undefined;
  let activityFile: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: Array<() => void> = [];
  const native = new Map<string, number>();
  const questions = new Set<string>();
  let explicitDepth = 0;

  function flush(): boolean {
    if (!state || !activityFile) return true;
    state.updatedAt = Date.now();
    const file = `${activityFile}.wait`;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
      return true;
    } catch {
      try { unlinkSync(temp); } catch {}
      return false;
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function publish(): void {
    if (!state) return;
    state.count = Math.min(MAX_DEPTH, explicitDepth + questions.size +
      [...native.values()].reduce((sum, n) => sum + n, 0));
    const written = flush();
    if (state.count === 0 && written) stopHeartbeat();
    else if (!heartbeat) {
      heartbeat = setInterval(() => {
        const ok = flush();
        if (ok && state?.count === 0) stopHeartbeat();
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    }
  }

  function teardown(): void {
    native.clear();
    questions.clear();
    explicitDepth = 0;
    if (state) { state.count = 0; flush(); }
    state = undefined;
    stopHeartbeat();
    for (const off of unsubscribe) off();
    unsubscribe = [];
  }

  pi.on("session_start", (_event, ctx) => {
    teardown();
    const env = process.env;
    const startedAt = Number(env.PI_SUBAGENT_START_TIME);
    if (ctx.mode !== "tui" || env.HERDR_ENV !== "1" ||
        !env.PI_SUBAGENT_ID || !env.PI_SUBAGENT_ACTIVITY_FILE ||
        !env.HERDR_PANE_ID || !env.PI_SUBAGENT_NAME ||
        !Number.isFinite(startedAt) || startedAt <= 0) return;
    activityFile = env.PI_SUBAGENT_ACTIVITY_FILE;
    cleanDeadWriterTemps(activityFile);
    state = {
      version: 1, runningChildId: env.PI_SUBAGENT_ID, startedAt,
      pid: process.pid, pane: env.HERDR_PANE_ID, name: env.PI_SUBAGENT_NAME,
      herdrSession: env.HERDR_SESSION ?? "", count: 0, updatedAt: Date.now(),
    };
    publish();
    unsubscribe = [
      pi.events.on("rpiv:ask-user:blocked", (payload: unknown) => {
        if (!state || !payload || typeof payload !== "object") return;
        const { active, toolCallId } = payload as { active?: unknown; toolCallId?: unknown };
        if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 1024) return;
        if (active === true && questions.size < MAX_DEPTH) questions.add(toolCallId);
        else if (active === false) questions.delete(toolCallId);
        else return;
        publish();
      }),
      pi.events.on("herdr:blocked", (payload: unknown) => {
        if (!state || !payload || typeof payload !== "object") return;
        const active = (payload as { active?: unknown }).active;
        if (active === true) explicitDepth = Math.min(MAX_DEPTH, explicitDepth + 1);
        else if (active === false) explicitDepth = Math.max(0, explicitDepth - 1);
        else return;
        publish();
      }),
    ];
  });

  function uiPrompt(kind: unknown, active: boolean): void {
    // custom also wraps live overlays that do not require a human response.
    // Real custom questions announce themselves through rpiv or herdr:blocked.
    if (!state || typeof kind !== "string" || !WAIT_KINDS.has(kind)) return;
    const depth = native.get(kind) ?? 0;
    native.set(kind, active ? Math.min(MAX_DEPTH, depth + 1) : Math.max(0, depth - 1));
    publish();
  }
  pi.on("ui_prompt_start", (event) => uiPrompt(event.kind, true));
  pi.on("ui_prompt_end", (event) => uiPrompt(event.kind, false));
  pi.on("tool_execution_end", (event) => {
    if (questions.delete(event.toolCallId)) publish();
  });
  pi.on("session_shutdown", teardown);
}
