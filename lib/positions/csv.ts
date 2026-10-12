import { parseFuturesSymbol } from "@/lib/futures/contracts";
import { parseOccSymbol } from "@/lib/greeks/occ";
import { findFuturesRoot } from "@/lib/futures/specs";

export type ParsedCsv = { headers: string[]; rows: string[][] };
export type BrokerCsvParser<T> = {
  name: string;
  parse: (headers: string[], rows: string[][]) => T[];
};

export function parseGenericCsv(content: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new RangeError("CSV contains an unclosed quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  const [headers, ...data] = rows;
  if (!headers?.length) throw new RangeError("CSV must contain a header row.");
  return {
    headers: headers.map((header) => header.trim().replace(/^\uFEFF/, "")),
    rows: data.map((values) => headers!.map((_, index) => values[index] ?? "")),
  };
}

export function inferAssetClass(symbol: string): "equity" | "option" | "future" {
  try {
    parseOccSymbol(symbol);
    return "option";
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  try {
    const parsed = parseFuturesSymbol(symbol);
    if (findFuturesRoot(parsed.root)) return "future";
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return "equity";
}

export async function transactionDedupeHash(input: {
  accountId: string;
  symbol: string;
  executedAt: string;
  quantity: number;
  price: number;
}): Promise<string> {
  const normalized = [
    input.accountId,
    input.symbol.trim().toUpperCase(),
    new Date(input.executedAt).toISOString(),
    input.quantity.toString(),
    input.price.toString(),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (value: string | number | null) => {
    const text = value === null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
}
