const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000;

export function addisWeekStart(timestamp: number): string {
  const addis = new Date(timestamp + ADDIS_OFFSET_MS);
  const daysSinceMonday = (addis.getUTCDay() + 6) % 7;
  addis.setUTCHours(0, 0, 0, 0);
  addis.setUTCDate(addis.getUTCDate() - daysSinceMonday);
  return addis.toISOString().slice(0, 10);
}
