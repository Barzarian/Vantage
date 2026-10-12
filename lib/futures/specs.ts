import specsJson from "@/data/futures-specs.json";
import { futuresRootSchema, type FuturesRoot } from "@/lib/market-data/schemas";

export const FUTURES_ROOTS: FuturesRoot[] = futuresRootSchema.array().parse(specsJson);
const rootsBySymbol = new Map(FUTURES_ROOTS.map((root) => [root.root, root]));

export function getFuturesRoot(root: string): FuturesRoot {
  const result = rootsBySymbol.get(root.trim().toUpperCase());
  if (!result) throw new RangeError(`Unknown futures root: ${root}.`);
  return result;
}

export function findFuturesRoot(root: string): FuturesRoot | undefined {
  return rootsBySymbol.get(root.trim().toUpperCase());
}
