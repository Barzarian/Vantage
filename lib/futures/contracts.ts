import { futuresContractSchema, type FuturesContract, type FuturesRoot } from "@/lib/market-data/schemas";

export const FUTURES_MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"] as const;
const MONTH_BY_CODE = new Map<string, number>(FUTURES_MONTH_CODES.map((code, index) => [code, index + 1]));
const CODE_BY_MONTH = new Map<number, typeof FUTURES_MONTH_CODES[number]>(
  FUTURES_MONTH_CODES.map((code, index) => [index + 1, code]),
);

export type ParsedFuturesSymbol = { root: string; monthCode: typeof FUTURES_MONTH_CODES[number]; year: number };

export function formatFuturesSymbol(
  root: string,
  monthCode: typeof FUTURES_MONTH_CODES[number],
  year: number,
  yearDigits: 1 | 2 = 1,
): string {
  if (!MONTH_BY_CODE.has(monthCode) || !Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new RangeError("Invalid futures month code or year.");
  }
  const yearText = yearDigits === 1 ? String(year % 10) : String(year % 100).padStart(2, "0");
  return `${root.trim().toUpperCase()}${monthCode}${yearText}`;
}

export function parseFuturesSymbol(symbol: string, asOf = new Date()): ParsedFuturesSymbol {
  const match = /^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/i.exec(symbol.trim().toUpperCase());
  if (!match) throw new RangeError(`Invalid futures contract symbol: ${symbol}.`);
  const root = match[1]!;
  const monthCode = match[2] as typeof FUTURES_MONTH_CODES[number];
  const encodedYear = Number(match[3]);
  const year = match[3]!.length === 1
    ? nearestFutureDecade(asOf.getFullYear(), encodedYear)
    : nearestFutureCentury(asOf.getFullYear(), encodedYear);
  return { root, monthCode, year };
}

export function futuresRootFromSymbol(symbol: string): string {
  try {
    return parseFuturesSymbol(symbol).root;
  } catch (error) {
    if (error instanceof RangeError) return symbol.trim().toUpperCase();
    throw error;
  }
}

function nearestFutureDecade(currentYear: number, digit: number): number {
  let year = Math.floor(currentYear / 10) * 10 + digit;
  if (year < currentYear) year += 10;
  return year;
}

function nearestFutureCentury(currentYear: number, shortYear: number): number {
  let year = Math.floor(currentYear / 100) * 100 + shortYear;
  if (year - currentYear > 50) year -= 100;
  else if (currentYear - year > 50) year += 100;
  return year;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function atUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export function buildFuturesContracts(root: FuturesRoot, asOf = new Date(), count = 12): FuturesContract[] {
  const current = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const candidates: FuturesContract[] = [];
  for (let offset = 0; candidates.length < count && offset < 72; offset += 1) {
    const monthDate = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + offset, 1));
    const month = monthDate.getUTCMonth() + 1;
    const code = CODE_BY_MONTH.get(month);
    if (!code || !root.contractMonths.includes(code)) continue;
    const year = monthDate.getUTCFullYear();
    const expiry = atUtc(year, month, 20);
    const lastTradeDate = new Date(expiry);
    lastTradeDate.setUTCDate(lastTradeDate.getUTCDate() - 3);
    const firstNotice = new Date(lastTradeDate);
    firstNotice.setUTCDate(firstNotice.getUTCDate() - 5);
    candidates.push(futuresContractSchema.parse({
      symbol: formatFuturesSymbol(root.root, code, year),
      root: root.root,
      monthCode: code,
      year,
      expiry: isoDate(expiry),
      lastTradeDate: isoDate(lastTradeDate),
      firstNoticeDate: root.settlement === "physical" ? isoDate(firstNotice) : null,
      isFront: false,
    }));
  }
  const frontIndex = resolveFrontIndex(candidates, root, asOf, { type: "days-before-expiry", days: root.rollDays });
  return candidates.map((contract, index) => ({ ...contract, isFront: index === frontIndex }));
}

export function resolveFrontIndex(
  contracts: FuturesContract[],
  root: FuturesRoot,
  asOf: Date,
  rule: { type: "days-before-expiry"; days: number } | { type: "volume-crossover" } | { type: "open-interest-crossover" } = { type: "days-before-expiry", days: root.rollDays },
  volume?: number[],
  openInterest?: number[],
): number {
  if (!contracts.length) throw new RangeError("Cannot resolve a front month from an empty contract list.");
  if (rule.type === "volume-crossover" || rule.type === "open-interest-crossover") {
    const values = rule.type === "volume-crossover" ? volume : openInterest;
    if (values && values.length >= 2) {
      for (let index = 0; index < contracts.length - 1; index += 1) {
        if ((values[index + 1] ?? 0) > (values[index] ?? 0)) return index + 1;
      }
    }
    return contracts.findIndex((contract) => new Date(`${contract.lastTradeDate}T23:59:59Z`) > asOf) || 0;
  }
  const rollThreshold = rule.days * 86400000;
  const index = contracts.findIndex((contract) =>
    Date.parse(`${contract.lastTradeDate}T23:59:59Z`) - asOf.getTime() > rollThreshold &&
    (!contract.firstNoticeDate || Date.parse(`${contract.firstNoticeDate}T23:59:59Z`) - asOf.getTime() > rollThreshold),
  );
  return index < 0 ? contracts.length - 1 : index;
}

export function resolveFrontAndNext(
  contracts: FuturesContract[],
  root: FuturesRoot,
  asOf = new Date(),
  rule?: Parameters<typeof resolveFrontIndex>[3],
): { front: FuturesContract; next: FuturesContract | null } {
  const index = resolveFrontIndex(contracts, root, asOf, rule);
  return { front: contracts[index]!, next: contracts[index + 1] ?? null };
}

export function daysToExpiry(contract: FuturesContract, asOf = new Date()): number {
  return Math.max(0, Math.ceil((Date.parse(`${contract.lastTradeDate}T23:59:59Z`) - asOf.getTime()) / 86400000));
}

export function daysToFirstNotice(contract: FuturesContract, asOf = new Date()): number | null {
  return contract.firstNoticeDate
    ? Math.max(0, Math.ceil((Date.parse(`${contract.firstNoticeDate}T23:59:59Z`) - asOf.getTime()) / 86400000))
    : null;
}
