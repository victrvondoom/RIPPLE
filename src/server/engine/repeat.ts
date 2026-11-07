/**
 * Repeat suppression (session 16; inherited from Gatekeeper's scout, which will not re-say the same finding within 5 minutes).
 * A finding that repeats inside the window is not recorded again. Suppression is not silence: the first occurrence is always
 * recorded, and a later occurrence after the window is recorded again. Pure and deterministic; the caller supplies the clock.
 */
export class RepeatGuard {
  private last = new Map<string, number>();
  constructor(private windowMs = 5 * 60_000) {}

  /** True if `key` should be recorded now; false if the same key was already recorded inside the window. */
  admit(key: string, nowMs: number = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.windowMs) return false;
    this.last.set(key, nowMs);
    return true;
  }
}
