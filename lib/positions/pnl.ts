export type AssetClass = "stock" | "future" | "option";

export type PositionPnlInput = {
  assetClass: AssetClass;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  futuresMultiplier?: number;
};

export type PositionPnl = {
  multiplier: number;
  unrealizedPnl: number;
  costBasis: number;
  marketValue: number;
};

export type RealizedPnlInput = {
  assetClass: AssetClass;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  futuresMultiplier?: number;
};

export function getContractMultiplier(
  assetClass: AssetClass,
  futuresMultiplier?: number,
): number {
  if (assetClass === "option") return 100;
  if (assetClass === "stock") return 1;
  if (
    futuresMultiplier === undefined ||
    !Number.isFinite(futuresMultiplier) ||
    futuresMultiplier <= 0
  ) {
    throw new RangeError("A positive futures contract multiplier is required.");
  }
  return futuresMultiplier;
}

function validatePnlValues(quantity: number, entryPrice: number, markOrExitPrice: number) {
  if (![quantity, entryPrice, markOrExitPrice].every(Number.isFinite)) {
    throw new RangeError("Position quantity and prices must be finite numbers.");
  }
  if (entryPrice < 0 || markOrExitPrice < 0) {
    throw new RangeError("Position prices must be non-negative.");
  }
}

export function calculatePositionPnl(input: PositionPnlInput): PositionPnl {
  validatePnlValues(input.quantity, input.entryPrice, input.markPrice);
  const multiplier = getContractMultiplier(input.assetClass, input.futuresMultiplier);
  const costBasis = Math.abs(input.quantity) * input.entryPrice * multiplier;
  const marketValue = Math.abs(input.quantity) * input.markPrice * multiplier;
  const unrealizedPnl =
    (input.markPrice - input.entryPrice) * input.quantity * multiplier;
  return { multiplier, unrealizedPnl, costBasis, marketValue };
}

export function calculateRealizedPnl(input: RealizedPnlInput): number {
  validatePnlValues(input.quantity, input.entryPrice, input.exitPrice);
  const multiplier = getContractMultiplier(input.assetClass, input.futuresMultiplier);
  return (input.exitPrice - input.entryPrice) * input.quantity * multiplier;
}

export function calculatePortfolioPnl(positions: PositionPnlInput[]): number {
  return positions.reduce((total, position) => total + calculatePositionPnl(position).unrealizedPnl, 0);
}
