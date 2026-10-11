export type PriceBar = {
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MacdPoint = {
  macd: number;
  signal: number;
  histogram: number;
};

export type BollingerPoint = {
  middle: number;
  upper: number;
  lower: number;
};

function validatePeriod(period: number) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("Period must be a positive integer.");
  }
}

function validateValues(values: number[]) {
  if (!values.every(Number.isFinite)) {
    throw new RangeError("Indicator values must be finite numbers.");
  }
}

export function simpleMovingAverage(values: number[], period: number): Array<number | null> {
  validatePeriod(period);
  validateValues(values);
  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

export function exponentialMovingAverage(values: number[], period: number): Array<number | null> {
  validatePeriod(period);
  validateValues(values);
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;

  const alpha = 2 / (period + 1);
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < values.length; index += 1) {
    average = values[index]! * alpha + average * (1 - alpha);
    result[index] = average;
  }
  return result;
}

export function relativeStrengthIndex(values: number[], period: number): Array<number | null> {
  validatePeriod(period);
  validateValues(values);
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiFromAverages(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return result;
}

function rsiFromAverages(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function movingAverageConvergenceDivergence(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): Array<MacdPoint | null> {
  validatePeriod(fastPeriod);
  validatePeriod(slowPeriod);
  validatePeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new RangeError("Fast period must be less than slow period.");
  }
  validateValues(values);

  const fast = exponentialMovingAverage(values, fastPeriod);
  const slow = exponentialMovingAverage(values, slowPeriod);
  const macdValues = values.map((_, index) =>
    fast[index] === null || slow[index] === null ? null : fast[index]! - slow[index]!,
  );
  const firstMacdIndex = slowPeriod - 1;
  const signalValues = exponentialMovingAverage(
    macdValues.slice(firstMacdIndex) as number[],
    signalPeriod,
  );
  const result: Array<MacdPoint | null> = Array(values.length).fill(null);
  for (let index = 0; index < values.length; index += 1) {
    const signalIndex = index - firstMacdIndex;
    const macd = macdValues[index];
    const signal = signalValues[signalIndex];
    if (macd !== null && macd !== undefined && signal !== null && signal !== undefined) {
      result[index] = { macd, signal, histogram: macd - signal };
    }
  }
  return result;
}

export function bollingerBands(
  values: number[],
  period: number,
  standardDeviations = 2,
): Array<BollingerPoint | null> {
  validatePeriod(period);
  validateValues(values);
  if (!Number.isFinite(standardDeviations) || standardDeviations < 0) {
    throw new RangeError("Standard deviations must be a finite non-negative number.");
  }
  const result: Array<BollingerPoint | null> = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const middle = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * standardDeviations;
    result[index] = { middle, upper: middle + deviation, lower: middle - deviation };
  }
  return result;
}

export function volumeWeightedAveragePrice(bars: PriceBar[]): Array<number | null> {
  let cumulativeVolume = 0;
  let cumulativePriceVolume = 0;
  return bars.map((bar) => {
    if (![bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) || bar.volume < 0) {
      throw new RangeError("Bars must contain finite prices and non-negative volume.");
    }
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
  });
}

export function sessionVolumeWeightedAveragePrice(
  bars: PriceBar[],
  sessionKey: (index: number) => string = (index) => new Date(index * 86_400_000).toISOString().slice(0, 10),
): Array<number | null> {
  let currentSession = "";
  let cumulativeVolume = 0;
  let cumulativePriceVolume = 0;
  return bars.map((bar, index) => {
    if (![bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) || bar.volume < 0) {
      throw new RangeError("Bars must contain finite prices and non-negative volume.");
    }
    const key = sessionKey(index);
    if (key !== currentSession) {
      currentSession = key;
      cumulativeVolume = 0;
      cumulativePriceVolume = 0;
    }
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
  });
}
