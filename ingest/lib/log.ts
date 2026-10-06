/** Minimal structured logger — timestamped, level-prefixed lines. */
type Level = 'info' | 'warn' | 'error' | 'step';

function emit(level: Level, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const line = `${ts} ${tag} ${msg}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  // '%s' keeps user-influenced text from acting as a format string.
  if (extra !== undefined) stream('%s', line, extra);
  else stream('%s', line);
}

export const log = {
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
  /** A pipeline milestone line (spec §5.7 transparency style). */
  step: (msg: string, extra?: unknown) => emit('step', `▸ ${msg}`, extra),
};

/** Sleep helper for polite API pacing / rate limits. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
