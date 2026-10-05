/**
 * Per-run cancellation (review R12). A screen runs for minutes and makes
 * several paid LLM calls; when the browser tab closes or an MCP client
 * cancels, the work must stop instead of finishing for nobody.
 *
 * The run's AbortSignal travels through AsyncLocalStorage, so the pipeline
 * stages do not need a signal parameter each: callClaude (and the retrieval
 * embed) read it here, abort their in-flight request and never retry. Pure
 * module: no env, no network.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<AbortSignal>();

/** Thrown when the client that asked for a run has gone away. */
export class RunAbortedError extends Error {
  constructor(message = 'The run was cancelled because the client disconnected.') {
    super(message);
    this.name = 'RunAbortedError';
  }
}

/** Run `fn` with `signal` as the current run's cancellation signal. */
export function withRunSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? store.run(signal, fn) : fn();
}

/** The current run's cancellation signal, if any. */
export function currentRunSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Throw RunAbortedError when `signal` (default: the current run's) has fired. */
export function throwIfRunAborted(signal: AbortSignal | undefined = store.getStore()): void {
  if (signal?.aborted) throw new RunAbortedError();
}
