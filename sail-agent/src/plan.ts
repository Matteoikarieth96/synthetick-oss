/**
 * The day plan — the pipeline's output, persisted so execution ticks (and
 * process restarts) drain it without re-running news/thesis/screen.
 * Lives at .sail/memory/plan.json; expires after planTtlHours so stale
 * decisions never execute.
 */
import fs from "node:fs";
import path from "node:path";
import type { PlannedTrade } from "./decide.js";

export interface PlanTrade extends PlannedTrade {
  status: "pending" | "submitted" | "done" | "failed";
  note?: string;
}

export interface DayPlan {
  createdAt: number; // unix seconds
  expiresAt: number;
  pipelineDate: string; // YYYY-MM-DD UTC of the pipeline run
  thesisTitle: string;
  trades: PlanTrade[];
}

const PLAN_PATH = path.join(process.cwd(), ".sail", "memory", "plan.json");

/** plan.json exists but cannot be read as a plan. */
export class PlanFileCorruptError extends Error {
  constructor(detail: string) {
    super(
      `${PLAN_PATH} is unreadable (${detail}). Refusing to plan again: the file is the once-per-day guard, ` +
        "and re-running the pipeline blind could repeat today's trades. Check .sail/memory/ledger.jsonl, then repair or delete the file.",
    );
    this.name = "PlanFileCorruptError";
  }
}

/**
 * The plan file, read once: null when there is none yet, the plan otherwise.
 * A file that exists but does not parse is NOT "no plan": treating it that way
 * made lastPipelineDate() null, the daily guard re-ran the pipeline, and the
 * new plan bought again on the same day. Fail closed instead.
 */
function readPlanFile(): DayPlan | null {
  let text: string;
  try {
    text = fs.readFileSync(PLAN_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanFileCorruptError((e as Error).message);
  }
  let plan: DayPlan;
  try {
    plan = JSON.parse(text) as DayPlan;
  } catch (e) {
    throw new PlanFileCorruptError((e as Error).message);
  }
  if (!plan || typeof plan !== "object" || typeof plan.pipelineDate !== "string" || !Array.isArray(plan.trades)) {
    throw new PlanFileCorruptError("not a day plan");
  }
  return plan;
}

/** The live plan, or null when there is none or it expired. Throws
 * PlanFileCorruptError when the file is unreadable (see readPlanFile). */
export function loadPlan(nowSec: number): DayPlan | null {
  const plan = readPlanFile();
  if (!plan || plan.expiresAt < nowSec) return null;
  return plan;
}

/** The last pipeline date, live plan or not — the once-per-day guard's input.
 * Throws PlanFileCorruptError rather than answering null for a broken file. */
export function lastPipelineDate(): string | null {
  return readPlanFile()?.pipelineDate ?? null;
}

/** Write `data` so readers only ever see the old file or the new one: a crash
 * or a full disk mid-write used to leave a truncated plan.json behind. */
function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort: a stray temp file is harmless
    }
    throw e;
  }
}

export function savePlan(plan: DayPlan): void {
  writeFileAtomic(PLAN_PATH, JSON.stringify(plan, null, 2));
}

/**
 * Pipeline attempt counter — written BEFORE the pipeline runs, unlike the
 * plan (written only on success). Without it, a persistently failing screen
 * re-runs news/thesis/Drip on every tick all day, burning tokens and cents.
 */
const ATTEMPTS_PATH = path.join(process.cwd(), ".sail", "memory", "attempts.json");

export function pipelineAttempts(date: string): number {
  try {
    const rec = JSON.parse(fs.readFileSync(ATTEMPTS_PATH, "utf-8")) as { date: string; count: number };
    return rec.date === date ? rec.count : 0;
  } catch {
    return 0;
  }
}

export function recordPipelineAttempt(date: string): void {
  writeFileAtomic(ATTEMPTS_PATH, JSON.stringify({ date, count: pipelineAttempts(date) + 1 }, null, 2));
}
