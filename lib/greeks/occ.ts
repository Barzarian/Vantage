import { z } from "zod";
import { optionContractSchema, type OptionContract } from "@/lib/market-data/schemas";

const occPattern = /^([A-Z0-9. ]{1,6})(\d{6})([CP])(\d{8})$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function parseOccSymbol(occSymbol: string): OptionContract {
  const normalized = occSymbol.trim().toUpperCase();
  const match = occPattern.exec(normalized);
  if (!match) throw new RangeError(`Invalid OCC option symbol: ${occSymbol}`);
  const [, rootField, date, side, strike] = match;
  const root = rootField!.trim();
  if (!/^[A-Z0-9.]{1,6}$/.test(root)) throw new RangeError(`Invalid OCC root in symbol: ${occSymbol}`);
  const expiry = `20${date!.slice(0, 2)}-${date!.slice(2, 4)}-${date!.slice(4, 6)}`;
  if (!isCalendarDate(expiry)) throw new RangeError(`Invalid OCC expiry in symbol: ${occSymbol}`);
  return optionContractSchema.parse({
    occSymbol: normalized,
    underlying: root,
    expiry,
    strike: Number(strike) / 1000,
    type: side === "C" ? "call" : "put",
    multiplier: 100,
  });
}

export function formatOccSymbol(contract: Pick<OptionContract, "underlying" | "expiry" | "strike" | "type">): string {
  const underlying = z.string().trim().min(1).max(6).regex(/^[A-Z0-9.]+$/)
    .parse(contract.underlying.toUpperCase());
  if (!datePattern.test(contract.expiry) || !isCalendarDate(contract.expiry)) {
    throw new RangeError("OCC expiry must be a valid YYYY-MM-DD date.");
  }
  if (!Number.isFinite(contract.strike) || contract.strike <= 0) {
    throw new RangeError("OCC strike must be a positive finite number.");
  }
  const scaledStrike = Math.round(contract.strike * 1000);
  if (scaledStrike > 99_999_999) throw new RangeError("OCC strike exceeds the eight-digit format.");
  const expiry = contract.expiry.slice(2).replaceAll("-", "");
  const optionType = contract.type === "call" ? "C" : "P";
  return `${underlying.padEnd(6, " ")}${expiry}${optionType}${String(scaledStrike).padStart(8, "0")}`;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}
