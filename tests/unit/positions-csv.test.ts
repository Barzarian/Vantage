import { describe, expect, it } from "vitest";
import { inferAssetClass, parseGenericCsv, toCsv } from "../../lib/positions/csv";

describe("positions CSV helpers", () => {
  it("parses escaped quotes, commas, line endings, and padded OCC symbols", () => {
    const csv = 'Symbol,Notes,Quantity\r\n"SPY   261016C00575000","Filled, then ""held""",2\r\n';
    const parsed = parseGenericCsv(csv);
    expect(parsed.headers).toEqual(["Symbol", "Notes", "Quantity"]);
    expect(parsed.rows).toEqual([["SPY   261016C00575000", 'Filled, then "held"', "2"]]);
    expect(inferAssetClass(parsed.rows[0]![0]!)).toBe("option");
  });

  it("detects a valid futures month-code contract and writes standards-compliant CSV cells", () => {
    expect(inferAssetClass("ESZ6")).toBe("future");
    expect(toCsv([{ symbol: "AAPL", notes: 'comma, and "quotes"' }])).toBe('symbol,notes\r\nAAPL,"comma, and ""quotes"""');
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseGenericCsv('symbol,notes\nAAPL,"unfinished')).toThrow(RangeError);
  });
});
