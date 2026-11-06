import { describe, expect, it } from "vitest";

import { appTimestampKey, formatAppTimestamp } from "./app-time";


describe("formatAppTimestamp", () => {
  it("renders offset-bearing stamps in the display zone, not the host zone", () => {
    // 08:11 UTC is 16:11 in Beijing. A browser in, say, UTC+2 must still print
    // the Beijing reading, because that is the zone the operators work in.
    const rendered = formatAppTimestamp("2026-10-04T08:11:00Z");
    expect(rendered).toBe("2026/10/04 16:11");
  });

  it("keeps existing offsets intact", () => {
    expect(formatAppTimestamp("2026-10-04T16:11:36+08:00")).toBe("2026/10/04 16:11");
  });

  it("returns a placeholder for empty values", () => {
    expect(formatAppTimestamp(undefined)).toBe("-");
    expect(formatAppTimestamp(null)).toBe("-");
    expect(formatAppTimestamp("")).toBe("-");
    expect(formatAppTimestamp("   ")).toBe("-");
  });

  it("echoes unparseable input instead of hiding it", () => {
    // The legacy "MM/DD HH:MM" label carries no year or zone, so it must stay
    // visible rather than being silently blanked from the table.
    expect(formatAppTimestamp("07/27 14:47")).toBe("07/27 14:47");
    expect(formatAppTimestamp("not-a-time")).toBe("not-a-time");
  });
});

describe("appTimestampKey", () => {
  it("orders by instant so equal wall clocks in different zones do not collide", () => {
    const beijing = appTimestampKey("2026-10-04T16:11:00+08:00");
    const utc = appTimestampKey("2026-10-04T08:11:00Z");
    expect(beijing).toBe(utc);
  });

  it("places unparseable and missing values last", () => {
    expect(appTimestampKey("")).toBeLessThan(appTimestampKey("2026-01-01T00:00:00Z"));
    expect(appTimestampKey("junk")).toBeLessThan(appTimestampKey("2026-01-01T00:00:00Z"));
  });
});
