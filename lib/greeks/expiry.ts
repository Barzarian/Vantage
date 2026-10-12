const EXPIRY_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const expiryTimestampCache = new Map<string, number>();

export function optionExpiryTimestamp(expiry: string): number {
  const cached = expiryTimestampCache.get(expiry);
  if (cached !== undefined) return cached;
  const match = EXPIRY_DATE.exec(expiry);
  if (!match) throw new RangeError("Option expiry must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcGuess = Date.UTC(year, month - 1, day, 16);
  const actualDate = new Date(Date.UTC(year, month - 1, day));
  if (
    actualDate.getUTCFullYear() !== year ||
    actualDate.getUTCMonth() !== month - 1 ||
    actualDate.getUTCDate() !== day
  ) throw new RangeError("Option expiry must be a valid calendar date.");

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcGuess);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  const representedUtc = Date.UTC(
    values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!,
  );
  const timestamp = Math.floor((utcGuess - (representedUtc - utcGuess)) / 1000);
  expiryTimestampCache.set(expiry, timestamp);
  return timestamp;
}

export function timeToOptionExpiry(expiry: string, now = Date.now()): number {
  if (!Number.isFinite(now)) throw new RangeError("Current time must be finite.");
  return Math.max(0, (optionExpiryTimestamp(expiry) * 1000 - now) / (365 * 24 * 60 * 60 * 1000));
}
