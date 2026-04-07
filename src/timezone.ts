import { DateTime } from "luxon";

const DAY_RESET_HOUR = 7;

export function getNextDayBoundary(timezone: string, nowUtc: string): string {
  const now = DateTime.fromISO(nowUtc, { zone: "utc" }).setZone(timezone);
  let boundary = now.set({ hour: DAY_RESET_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (boundary <= now) {
    boundary = boundary.plus({ days: 1 });
  }
  return boundary.toUTC().toISO()!;
}

export function getPreviousDayBoundary(timezone: string, nextBoundaryUtc: string): string {
  const next = DateTime.fromISO(nextBoundaryUtc, { zone: "utc" }).setZone(timezone);
  const prev = next.minus({ days: 1 });
  return prev.toUTC().toISO()!;
}

export function advanceBoundary(timezone: string, currentBoundaryUtc: string): string {
  const current = DateTime.fromISO(currentBoundaryUtc, { zone: "utc" }).setZone(timezone);
  const next = current.plus({ days: 1 });
  return next.toUTC().toISO()!;
}
