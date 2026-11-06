/**
 * Timestamps produced by the API always carry an explicit UTC offset and are
 * meant to be read in Asia/Shanghai, which is where the operators are. The
 * API and worker containers run on a UTC clock, so anything rendered against
 * the browser's own zone drifts by eight hours whenever those two disagree.
 * Rendering therefore pins the display zone instead of trusting the machine.
 */

const DISPLAY_TIMEZONE = "Asia/Shanghai";

const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: DISPLAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

// Only year-first stamps are handed to `Date`. V8 also accepts the retired
// "MM/DD HH:MM" label and silently files it under the year 2001, which would
// turn a stale legacy value into a plausible-looking wrong date.
const PARSEABLE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Render a stored timestamp for operators. Anything the formatter does not
 * recognise is echoed back rather than blanked or re-dated, so it stays
 * visible in the UI instead of silently disappearing.
 */
export function formatAppTimestamp(value?: string | null): string {
  if (value === undefined || value === null) return "-";
  const text = String(value).trim();
  if (!text) return "-";
  if (!PARSEABLE.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString("zh-CN", FORMAT_OPTIONS);
}

/** Sort key for ordering records by recency; unparseable values sort last. */
export function appTimestampKey(value?: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const text = String(value).trim();
  if (!PARSEABLE.test(text)) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? Number.NEGATIVE_INFINITY : parsed.getTime();
}
