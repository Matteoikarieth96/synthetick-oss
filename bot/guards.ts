/**
 * Liveness and cost guards for the X bot worker (final audit H2, L9). Pure:
 * no env.ts import, no network, so the offline suite exercises them; the
 * worker (bot/worker.ts) runs on import and wires them in.
 *
 *   withDeadline       a per-mention time limit that also aborts the work
 *   installExitGuards  a drained event loop or an uncaught error exits 1, so
 *                      Railway's restart policy ("on failure") brings the
 *                      worker back; a clean exit 0 is never restarted
 *   ReplyBudget        template replies at most once per author per UTC day,
 *                      plus a global daily cap on every post (X bills each one)
 */

/** Thrown when a mention's work runs past its deadline. */
export class DeadlineError extends Error {
  constructor(readonly ms: number, label = 'work') {
    super(`${label} did not finish within ${Math.round(ms / 1000)} s`);
    this.name = 'DeadlineError';
  }
}

/**
 * Run `work` with a deadline: after `ms` its signal aborts (LLM calls under
 * withRunSignal stop at once) and the returned promise rejects with
 * DeadlineError, whether or not the work ever settles. The timer is always
 * cleared, so a finished mention leaves nothing behind.
 */
export function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, label = 'work'): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError(ms, label);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  let running: Promise<T>;
  try {
    running = work(ac.signal);
  } catch (err) {
    running = Promise.reject(err);
  }
  running.catch(() => {}); // a late rejection after the deadline is not an unhandled rejection
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer));
}

/** Per-mention limits from X_BOT_MENTION_TIMEOUT_SECONDS (default 240, 60..900). The
 * post-charge work gets 30 s less, leaving time to refund and reply on a timeout. */
export function mentionTimeouts(env: Record<string, string | undefined> = process.env): { mentionMs: number; workMs: number } {
  const raw = Number(env.X_BOT_MENTION_TIMEOUT_SECONDS);
  const sec = Number.isFinite(raw) && raw > 0 ? Math.min(900, Math.max(60, Math.trunc(raw))) : 240;
  return { mentionMs: sec * 1000, workMs: (sec - 30) * 1000 };
}

type ExitLog = { error: (msg: string, extra?: unknown) => void };
type ProcessLike = {
  on(event: 'beforeExit', fn: (code: number) => void): unknown;
  on(event: 'uncaughtException', fn: (err: Error) => void): unknown;
  on(event: 'unhandledRejection', fn: (reason: unknown) => void): unknown;
  exit(code?: number): never | void;
};

/**
 * The worker is an endless poll loop: it never ends on its own. If its event
 * loop drains anyway (a promise that can never settle holds no handle, the
 * gzip hang of final audit H2), or an error escapes, exit with code 1. Railway
 * restarts a failed worker but NOT one that exited 0, which is how the bot
 * used to stay down until the next deploy.
 */
export function installExitGuards(proc: ProcessLike, log: ExitLog): void {
  proc.on('beforeExit', (code) => {
    log.error(`bot: the event loop drained unexpectedly (exit code ${code}); exiting 1 so the worker is restarted`);
    proc.exit(1);
  });
  proc.on('uncaughtException', (err) => {
    log.error('bot: uncaught exception; exiting 1 so the worker is restarted', err);
    proc.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    log.error('bot: unhandled promise rejection; exiting 1 so the worker is restarted', reason);
    proc.exit(1);
  });
}

/** The fixed template replies (no LLM): each goes to one author at most once per UTC day. */
export type TemplateReply = 'unlinked' | 'no_credits' | 'run_failed';

const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Reply cost guard (final audit L9). X pay-per-use bills every post, and the
 * template replies (pointer for unlinked authors, out of credits, run failed)
 * cost no credit, so a script could make the brand account post them without
 * limit. Each template goes to an author at most once per UTC day, and the
 * worker stops posting at all once X_BOT_MAX_REPLIES_PER_DAY (default 300)
 * posts went out today. The per-author memory is in process (the unlinked
 * pointer also has its database check); the daily count is persisted by the
 * worker in bot_state, so a restart does not reset it.
 */
export class ReplyBudget {
  private day: string;
  private posts = 0;
  private templates = new Set<string>();

  constructor(
    readonly maxPostsPerDay: number,
    private now: () => number = Date.now,
  ) {
    this.day = utcDate(this.now());
  }

  /** Default cap from X_BOT_MAX_REPLIES_PER_DAY (positive integer), else 300. */
  static fromEnv(env: Record<string, string | undefined> = process.env, now?: () => number): ReplyBudget {
    const n = Number(env.X_BOT_MAX_REPLIES_PER_DAY);
    return new ReplyBudget(Number.isInteger(n) && n > 0 ? n : 300, now);
  }

  private roll(): void {
    const today = utcDate(this.now());
    if (today !== this.day) {
      this.day = today;
      this.posts = 0;
      this.templates.clear();
    }
  }

  /** Restore today's post count after a restart (ignored when `day` is not today). */
  restore(day: string, posts: number): void {
    this.roll();
    if (day === this.day && Number.isInteger(posts) && posts > this.posts) this.posts = posts;
  }

  /** True while today's global cap allows one more post. */
  canPost(): boolean {
    this.roll();
    return this.posts < this.maxPostsPerDay;
  }

  /** Count a post that went out; returns the state to persist. */
  recordPost(): { day: string; posts: number } {
    this.roll();
    this.posts += 1;
    return { day: this.day, posts: this.posts };
  }

  /** True when `kind` has not gone to `author` yet today AND the global cap allows a post. */
  templateAllowed(kind: TemplateReply, author: string): boolean {
    this.roll();
    return !this.templates.has(`${kind}:${author}`) && this.canPost();
  }

  /** Remember that `kind` went to `author` today. */
  recordTemplate(kind: TemplateReply, author: string): void {
    this.roll();
    this.templates.add(`${kind}:${author}`);
  }

  get postsToday(): number {
    this.roll();
    return this.posts;
  }
}
