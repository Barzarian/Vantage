import {
  BarSizeSetting,
  EventName,
  WhatToShow,
  type IBApi,
} from "@stoqey/ib";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import type { ResolvedContract } from "./contracts.js";
import { toIbContract } from "./contracts.js";

export type HistoryTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";

export const timeframePlan = {
  "1m": { barSize: BarSizeSetting.MINUTES_ONE, chunkSeconds: 24 * 60 * 60, duration: "1 D" },
  "5m": { barSize: BarSizeSetting.MINUTES_FIVE, chunkSeconds: 7 * 86400, duration: "1 W" },
  "15m": { barSize: BarSizeSetting.MINUTES_FIFTEEN, chunkSeconds: 30 * 86400, duration: "1 M" },
  "1h": { barSize: BarSizeSetting.HOURS_ONE, chunkSeconds: 365 * 86400, duration: "1 Y" },
  "4h": { barSize: BarSizeSetting.HOURS_FOUR, chunkSeconds: 365 * 86400, duration: "1 Y" },
  "1d": { barSize: BarSizeSetting.DAYS_ONE, chunkSeconds: 365 * 86400, duration: "1 Y" },
  "1w": { barSize: BarSizeSetting.WEEKS_ONE, chunkSeconds: 5 * 365 * 86400, duration: "5 Y" },
  "1M": { barSize: BarSizeSetting.MONTHS_ONE, chunkSeconds: 10 * 365 * 86400, duration: "10 Y" },
} satisfies Record<HistoryTimeframe, { barSize: BarSizeSetting; chunkSeconds: number; duration: string }>;

export type HistoryBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const historyBarSchema = z.object({
  time: z.number().int().positive(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
});

export function durationFor(timeframe: HistoryTimeframe, rangeSeconds: number): string {
  if (!Number.isFinite(rangeSeconds) || rangeSeconds <= 0) {
    throw new RangeError("Historical range must be a positive number of seconds.");
  }
  const plan = timeframePlan[timeframe];
  if (!plan) throw new RangeError(`Unsupported IBKR timeframe: ${timeframe}`);
  const chunks = Math.ceil(rangeSeconds / plan.chunkSeconds);
  const durationUnit = plan.duration.slice(-1);
  const durationAmount = Number.parseInt(plan.duration, 10);
  return `${durationAmount * chunks} ${durationUnit}`;
}

export function chunkHistoryRange(
  timeframe: HistoryTimeframe,
  from: number,
  to: number,
): Array<{ from: number; to: number; duration: string }> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from) {
    throw new RangeError("Historical range must have valid epoch-second bounds.");
  }
  const plan = timeframePlan[timeframe];
  if (!plan) throw new RangeError(`Unsupported IBKR timeframe: ${timeframe}`);
  const chunks: Array<{ from: number; to: number; duration: string }> = [];
  let cursor = to;
  while (cursor > from) {
    const start = Math.max(from, cursor - plan.chunkSeconds);
    const actualSeconds = cursor - start;
    const amount = Math.max(1, Math.ceil(actualSeconds / plan.chunkSeconds * Number.parseInt(plan.duration, 10)));
    chunks.push({ from: start, to: cursor, duration: `${amount} ${plan.duration.slice(-1)}` });
    cursor = start;
    if (chunks.length > 10_000) throw new RangeError("Requested historical range is too large.");
  }
  return chunks.reverse();
}

export interface HistoricalBarCache {
  get(key: string): Promise<HistoryBar[] | undefined>;
  set(key: string, bars: HistoryBar[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryHistoricalBarCache implements HistoricalBarCache {
  private readonly cache = new Map<string, { bars: HistoryBar[]; expiresAt: number }>();
  constructor(private readonly ttlMs = 5 * 60_000) {}
  async get(key: string) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.bars;
  }
  async set(key: string, bars: HistoryBar[]) {
    this.cache.set(key, { bars, expiresAt: Date.now() + this.ttlMs });
  }
  async close() {}
}

export class PostgresHistoricalBarCache implements HistoricalBarCache {
  private readonly sql: Sql;
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 2, idle_timeout: 20 });
  }
  async initialize() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS ib_historical_cache (
        cache_key TEXT PRIMARY KEY,
        bars JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }
  async get(key: string) {
    const rows = await this.sql`
      SELECT bars FROM ib_historical_cache
      WHERE cache_key = ${key} AND expires_at > NOW()
      LIMIT 1
    `;
    if (!rows[0]) return undefined;
    return z.array(historyBarSchema).parse(rows[0].bars);
  }
  async set(key: string, bars: HistoryBar[]) {
    await this.sql`
      INSERT INTO ib_historical_cache (cache_key, bars, expires_at)
      VALUES (${key}, ${JSON.stringify(bars)}::jsonb, NOW() + INTERVAL '5 minutes')
      ON CONFLICT (cache_key) DO UPDATE SET
        bars = EXCLUDED.bars, expires_at = EXCLUDED.expires_at, updated_at = NOW()
    `;
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
}

export class HistoricalRequestQueue {
  private readonly dispatchedAt: number[] = [];
  private readonly duplicateAt = new Map<string, number>();
  private waiting = 0;
  private lastDispatchedAt = 0;

  get queuedRequests() {
    return this.waiting;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    try {
      while (true) {
        const now = Date.now();
        while (this.dispatchedAt[0] !== undefined && this.dispatchedAt[0] <= now - 600_000) {
          this.dispatchedAt.shift();
        }
        const sameRequestAt = this.duplicateAt.get(key) ?? 0;
        const burst = this.dispatchedAt.filter((time) => time > now - 2_000);
        const waitForSpacing = Math.max(0, this.lastDispatchedAt + 350 - now);
        const waitForBurst = burst.length >= 6 ? Math.max(1, burst[0]! + 2_000 - now) : 0;
        const waitForWindow =
          this.dispatchedAt.length >= 60 ? Math.max(1, this.dispatchedAt[0]! + 600_000 - now) : 0;
        const waitForDuplicate = Math.max(0, sameRequestAt + 15_000 - now);
        const waitMs = Math.max(waitForSpacing, waitForBurst, waitForWindow, waitForDuplicate);
        if (waitMs === 0) {
          const dispatched = Date.now();
          this.dispatchedAt.push(dispatched);
          this.lastDispatchedAt = dispatched;
          this.duplicateAt.set(key, dispatched);
          return await operation();
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } finally {
      this.waiting -= 1;
    }
  }
}

export class HistoricalDataService {
  private nextRequestId = 30_000;
  private readonly inFlight = new Map<string, Promise<HistoryBar[]>>();

  constructor(
    private readonly getApi: () => IBApi,
    private readonly cache: HistoricalBarCache,
    readonly queue = new HistoricalRequestQueue(),
    private readonly useRthEquities = true,
  ) {}

  async getBars(
    contract: ResolvedContract,
    timeframe: HistoryTimeframe,
    from: number,
    to: number,
    useRth?: boolean,
  ): Promise<HistoryBar[]> {
    const rth = useRth ?? (contract.secType !== "FUT" && this.useRthEquities);
    const key = `${contract.conId}:${timeframe}:${from}:${to}:${rth ? 1 : 0}`;
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.fetchRange(contract, timeframe, from, to, rth)
      .then(async (bars) => {
        await this.cache.set(key, bars);
        return bars;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchRange(
    contract: ResolvedContract,
    timeframe: HistoryTimeframe,
    from: number,
    to: number,
    useRth: boolean,
  ): Promise<HistoryBar[]> {
    const chunks = chunkHistoryRange(timeframe, from, to);
    const result: HistoryBar[] = [];
    for (const chunk of chunks) {
      const chunkKey = `${contract.conId}:${timeframe}:${chunk.from}:${chunk.to}:${useRth ? 1 : 0}`;
      const chunkBars = await this.queue.run(chunkKey, () =>
        this.requestChunk(contract, timeframe, chunk.from, chunk.to, chunk.duration, useRth),
      );
      result.push(...chunkBars);
    }
    const unique = new Map<number, HistoryBar>();
    for (const bar of result) {
      if (bar.time >= from && bar.time <= to) unique.set(bar.time, bar);
    }
    return [...unique.values()].sort((a, b) => a.time - b.time);
  }

  private requestChunk(
    contract: ResolvedContract,
    timeframe: HistoryTimeframe,
    from: number,
    to: number,
    duration: string,
    useRth: boolean,
  ): Promise<HistoryBar[]> {
    const api = this.getApi();
    const reqId = this.nextRequestId++;
    const bars: HistoryBar[] = [];
    const endDateTime = formatIbDateTime(to);
    const size = timeframePlan[timeframe].barSize;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out loading IBKR history for ${contract.symbol}.`));
      }, 45_000);
      const onBar = (
        responseId: number,
        time: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
      ) => {
        if (responseId !== reqId) return;
        if (time.startsWith("finished")) {
          cleanup();
          resolve(bars);
          return;
        }
        const epoch = Number(time);
        const bar = historyBarSchema.safeParse({
          time: Number.isFinite(epoch) ? epoch : Number.NaN,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? Math.max(0, volume) : 0,
        });
        if (bar.success) bars.push(bar.data);
      };
      const onError = (error: Error, code: number, responseId: number) => {
        if (responseId !== reqId || ![162, 200, 354].includes(code)) return;
        cleanup();
        reject(new Error(`IBKR historical data error ${code} for ${contract.symbol}: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        api.removeListener(EventName.historicalData, onBar);
        api.removeListener(EventName.error, onError);
      };
      api.on(EventName.historicalData, onBar);
      api.on(EventName.error, onError);
      api.reqHistoricalData(
        reqId,
        toIbContract(contract),
        endDateTime,
        duration,
        size,
        WhatToShow.TRADES,
        useRth,
        2,
        false,
      );
    });
  }
}

export function formatIbDateTime(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
    throw new RangeError("IBKR endDateTime requires epoch seconds.");
  }
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")} ${iso.slice(11, 19)} UTC`;
}
