/**
 * Quiet hours (session 16; inherited from Hermit's bedtime gate). Pure: the caller supplies the instant.
 * Hours are UTC because the engine keeps no per-user time zone. A window is [fromHour, toHour); it may wrap midnight.
 * A window with fromHour === toHour is empty (never quiet), so an unset or degenerate window cannot block anything by accident.
 * Imported by engine.ts (executeAction refuses while quiet, approval creation stores the window on the action).
 */
export interface QuietWindow { fromHour: number; toHour: number }

export function validQuietWindow(w: unknown): w is QuietWindow {
  if (!w || typeof w !== 'object') return false;
  const { fromHour, toHour } = w as QuietWindow;
  return Number.isInteger(fromHour) && Number.isInteger(toHour) && fromHour >= 0 && fromHour <= 23 && toHour >= 0 && toHour <= 23;
}

export function inQuietWindow(w: QuietWindow, now: Date): boolean {
  const h = now.getUTCHours();
  if (w.fromHour === w.toHour) return false;
  return w.fromHour < w.toHour ? h >= w.fromHour && h < w.toHour : h >= w.fromHour || h < w.toHour;
}
