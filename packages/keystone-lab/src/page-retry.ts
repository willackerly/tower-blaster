// Recovery for a cast page that is lost mid-play (G5 cast hardening). A cast
// on a shared Mac runs for hours; once, at play 136 of 186, the page's
// JavaScript context went away under a batch ("Execution context was
// destroyed") and the whole cast was lost. Each play runs from the level's
// start on a fresh engine (cast-page.ts), so a batch replayed on a freshly
// opened page plays exactly the same lines and returns the same results:
// replaying is safe. Only the page dying is retried; an error the cast page
// itself throws (a bad line, a failed level) is not, since replaying it would
// fail again the same way.

/** Messages that mean the page (its context, target, renderer or GPU device) went away, not that the play failed. */
export const PAGE_LOST = /Execution context was destroyed|Target (page, context or browser )?(has been )?closed|Target crashed|Page crashed|page has been closed|Frame was detached|frame got detached|GPU device lost|device (is |was )?lost|Navigating frame was detached/i;

export function isPageLost(e: unknown): boolean {
  return PAGE_LOST.test(e instanceof Error ? e.message : String(e));
}

export interface RetryOptions {
  /** Reopens after a lost page, at most this many times per call (default 2). */
  retries?: number;
  /** Which errors are a lost page (default isPageLost). */
  lost?: (e: unknown) => boolean;
  /** Called with each lost-page error before reopening, e.g. to log it. */
  onLost?: (e: unknown, attempt: number) => void;
}

/**
 * Runs `run`; when it fails with a lost page, awaits `reopen` and runs it again, up to `retries`
 * times. Any other error, or a failed reopen, is thrown at once; after the last retry the lost-page
 * error is thrown with the count in its message.
 */
export async function withPageRetry<T>(run: () => Promise<T>, reopen: () => Promise<void>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2, lost = opts.lost ?? isPageLost;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!lost(e)) throw e;
      if (attempt >= retries) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`the cast page was lost ${attempt + 1} times in one batch; last: ${msg}`, { cause: e });
      }
      opts.onLost?.(e, attempt + 1);
      await reopen();
    }
  }
}
