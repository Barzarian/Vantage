import { describe, expect, it } from "vitest";
import {
  chunkHistoryRange,
  durationFor,
  formatIbDateTime,
  timeframePlan,
} from "../../services/ibkr-bridge/src/history";

describe("IBKR historical duration and bar-size planning", () => {
  it("maps every dashboard timeframe to a supported IBKR bar size", () => {
    expect(Object.keys(timeframePlan)).toEqual(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]);
    expect(timeframePlan["1m"].barSize).toBe("1 min");
    expect(timeframePlan["4h"].barSize).toBe("4 hours");
    expect(timeframePlan["1M"].barSize).toBe("1 month");
  });

  it("selects valid duration units and grows duration by chunk count", () => {
    expect(durationFor("1m", 3600)).toBe("1 D");
    expect(durationFor("5m", 8 * 86400)).toBe("2 W");
    expect(durationFor("1w", 6 * 365 * 86400)).toBe("10 Y");
    expect(() => durationFor("1m", 0)).toThrow(RangeError);
  });

  it("splits longer requests into non-overlapping IBKR-sized ranges", () => {
    const chunks = chunkHistoryRange("1m", 100, 100 + 3 * 86400);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.from).toBe(100);
    expect(chunks[0]?.to).toBe(100 + 86400);
    expect(chunks[2]?.to).toBe(100 + 3 * 86400);
    expect(chunks.every((chunk) => chunk.duration === "1 D")).toBe(true);
    expect(() => chunkHistoryRange("5m", 10, 10)).toThrow(RangeError);
  });

  it("formats IBKR endDateTime in explicit UTC and rejects invalid epochs", () => {
    expect(formatIbDateTime(1_791_708_000)).toMatch(/^\d{8} \d{2}:\d{2}:\d{2} UTC$/);
    expect(() => formatIbDateTime(0)).toThrow(RangeError);
  });
});
