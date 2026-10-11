import {
  EventName,
  SecType,
  type Contract,
  type ContractDetails,
  type IBApi,
} from "@stoqey/ib";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

export const resolvedContractSchema = z.object({
  conId: z.number().int().positive(),
  symbol: z.string().min(1),
  localSymbol: z.string().optional(),
  name: z.string(),
  secType: z.enum(["STK", "IND", "FUT"]),
  exchange: z.string(),
  primaryExchange: z.string().optional(),
  currency: z.string(),
  minTick: z.number().positive().optional(),
  multiplier: z.string().optional(),
  lastTradeDate: z.string().optional(),
  contractMonth: z.string().optional(),
  tradingHours: z.string().optional(),
  timeZoneId: z.string().optional(),
});
export type ResolvedContract = z.infer<typeof resolvedContractSchema>;

export interface ContractStore {
  get(conId: number): Promise<ResolvedContract | undefined>;
  search(symbol: string): Promise<ResolvedContract[]>;
  save(contracts: ResolvedContract[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryContractStore implements ContractStore {
  private readonly byId = new Map<number, ResolvedContract>();
  async get(conId: number) {
    return this.byId.get(conId);
  }
  async search(symbol: string) {
    const key = symbol.trim().toUpperCase();
    return [...this.byId.values()].filter((contract) => contract.symbol.toUpperCase() === key);
  }
  async save(contracts: ResolvedContract[]) {
    for (const contract of contracts) this.byId.set(contract.conId, contract);
  }
  async close() {}
}

export class PostgresContractStore implements ContractStore {
  private readonly sql: Sql;
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 2, idle_timeout: 20 });
  }

  async initialize() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS ib_contracts (
        con_id BIGINT PRIMARY KEY,
        symbol TEXT NOT NULL,
        local_symbol TEXT,
        name TEXT NOT NULL,
        sec_type TEXT NOT NULL CHECK (sec_type IN ('STK', 'IND', 'FUT')),
        exchange TEXT NOT NULL,
        primary_exchange TEXT,
        currency TEXT NOT NULL,
        min_tick DOUBLE PRECISION,
        multiplier TEXT,
        last_trade_date TEXT,
        contract_month TEXT,
        trading_hours TEXT,
        time_zone_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS ib_contracts_symbol_idx ON ib_contracts (UPPER(symbol))`;
  }

  async get(conId: number) {
    const rows = await this.sql`SELECT * FROM ib_contracts WHERE con_id = ${conId} LIMIT 1`;
    return rows[0] ? rowToContract(rows[0]) : undefined;
  }

  async search(symbol: string) {
    const rows = await this.sql`
      SELECT * FROM ib_contracts WHERE UPPER(symbol) = ${symbol.trim().toUpperCase()}
      ORDER BY exchange, currency
    `;
    return rows.map(rowToContract);
  }

  async save(contracts: ResolvedContract[]) {
    for (const item of contracts) {
      await this.sql`
        INSERT INTO ib_contracts (
          con_id, symbol, local_symbol, name, sec_type, exchange, primary_exchange,
          currency, min_tick, multiplier, last_trade_date, contract_month, trading_hours, time_zone_id
        ) VALUES (
          ${item.conId}, ${item.symbol}, ${item.localSymbol ?? null}, ${item.name}, ${item.secType},
          ${item.exchange}, ${item.primaryExchange ?? null}, ${item.currency}, ${item.minTick ?? null},
          ${item.multiplier ?? null}, ${item.lastTradeDate ?? null}, ${item.contractMonth ?? null},
          ${item.tradingHours ?? null}, ${item.timeZoneId ?? null}
        )
        ON CONFLICT (con_id) DO UPDATE SET
          symbol = EXCLUDED.symbol, local_symbol = EXCLUDED.local_symbol, name = EXCLUDED.name,
          sec_type = EXCLUDED.sec_type, exchange = EXCLUDED.exchange,
          primary_exchange = EXCLUDED.primary_exchange, currency = EXCLUDED.currency,
          min_tick = EXCLUDED.min_tick, multiplier = EXCLUDED.multiplier,
          last_trade_date = EXCLUDED.last_trade_date, contract_month = EXCLUDED.contract_month,
          trading_hours = EXCLUDED.trading_hours, time_zone_id = EXCLUDED.time_zone_id,
          updated_at = NOW()
      `;
    }
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }
}

function rowToContract(row: Record<string, unknown>): ResolvedContract {
  return resolvedContractSchema.parse({
    conId: Number(row.con_id),
    symbol: row.symbol,
    localSymbol: row.local_symbol ?? undefined,
    name: row.name,
    secType: row.sec_type,
    exchange: row.exchange,
    primaryExchange: row.primary_exchange ?? undefined,
    currency: row.currency,
    minTick: row.min_tick === null ? undefined : Number(row.min_tick),
    multiplier: row.multiplier ?? undefined,
    lastTradeDate: row.last_trade_date ?? undefined,
    contractMonth: row.contract_month ?? undefined,
    tradingHours: row.trading_hours ?? undefined,
    timeZoneId: row.time_zone_id ?? undefined,
  });
}

function mapContract(details: ContractDetails): ResolvedContract | undefined {
  const contract = details.contract;
  if (
    !contract.conId ||
    !contract.symbol ||
    !contract.secType ||
    !contract.exchange ||
    !contract.currency ||
    !["STK", "IND", "FUT"].includes(contract.secType)
  ) {
    return undefined;
  }
  return resolvedContractSchema.parse({
    conId: contract.conId,
    symbol: contract.symbol,
    localSymbol: contract.localSymbol,
    name: details.longName ?? details.marketName ?? contract.symbol,
    secType:
      contract.secType === SecType.STK
        ? "STK"
        : contract.secType === SecType.IND
          ? "IND"
          : "FUT",
    exchange: contract.exchange,
    primaryExchange: contract.primaryExch,
    currency: contract.currency,
    minTick: details.minTick,
    multiplier: contract.multiplier === undefined ? undefined : String(contract.multiplier),
    lastTradeDate: contract.lastTradeDate,
    contractMonth: details.contractMonth ?? contract.lastTradeDateOrContractMonth,
    tradingHours: details.tradingHours,
    timeZoneId: details.timeZoneId,
  });
}

export class ContractResolver {
  private requestId = 2000;

  constructor(
    private readonly getApi: () => IBApi,
    private readonly store: ContractStore,
  ) {}

  async search(query: string): Promise<ResolvedContract[]> {
    const pattern = query.trim().toUpperCase();
    if (!pattern || pattern.length > 32) {
      throw new RangeError("Symbol query must contain 1 to 32 characters.");
    }
    const cached = await this.store.search(pattern);
    if (cached.length > 0) return cached;

    const api = this.getApi();
    const reqId = this.nextId();
    const candidates = await new Promise<Contract[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        api.removeListener(EventName.symbolSamples, onSamples);
        reject(new Error("Timed out waiting for IBKR symbol search."));
      }, 10_000);
      const onSamples = (responseId: number, descriptions: Array<{ contract?: Contract }>) => {
        if (responseId !== reqId) return;
        clearTimeout(timeout);
        api.removeListener(EventName.symbolSamples, onSamples);
        resolve(
          descriptions
            .map((description) => description.contract)
            .filter((contract): contract is Contract => !!contract)
            .filter((contract) => ["STK", "IND", "FUT"].includes(contract.secType ?? "")),
        );
      };
      api.on(EventName.symbolSamples, onSamples);
      api.reqMatchingSymbols(reqId, pattern);
    });

    const details = await Promise.all(candidates.map((contract) => this.getDetails(contract)));
    const contracts = details.flatMap((result) => {
      const mapped = mapContract(result);
      return mapped ? [mapped] : [];
    });
    const unique = [...new Map(contracts.map((contract) => [contract.conId, contract])).values()];
    await this.store.save(unique);
    return unique;
  }

  async byConId(conId: number): Promise<ResolvedContract> {
    const cached = await this.store.get(conId);
    if (cached) return cached;
    const result = await this.getDetails({ conId, exchange: "SMART" });
    const contract = mapContract(result);
    if (!contract) throw new Error(`IBKR returned no supported contract for conId ${conId}.`);
    await this.store.save([contract]);
    return contract;
  }

  async resolveFrontMonth(root: string, exchange: string, currency = "USD") {
    const contracts = await this.search(root);
    const futures = contracts
      .filter(
        (contract) =>
          contract.secType === "FUT" &&
          contract.exchange === exchange &&
          contract.currency === currency,
      )
      .map((contract) => ({ contract, expiry: normalizeExpiry(contract.lastTradeDate ?? contract.contractMonth) }))
      .filter((item) => item.expiry && item.expiry >= new Date().toISOString().slice(0, 10))
      .sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? ""));
    const front = futures[0];
    if (!front) throw new Error(`No current ${exchange} future found for ${root}.`);
    return front.contract;
  }

  private getDetails(contract: Contract): Promise<ContractDetails> {
    const api = this.getApi();
    const reqId = this.nextId();
    return new Promise((resolve, reject) => {
      const results: ContractDetails[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out resolving contract ${contract.symbol ?? contract.conId ?? ""}.`));
      }, 10_000);
      const onDetails = (responseId: number, details: ContractDetails) => {
        if (responseId === reqId) results.push(details);
      };
      const onEnd = (responseId: number) => {
        if (responseId !== reqId) return;
        cleanup();
        if (results[0]) resolve(results[0]);
        else reject(
          new Error(`No IBKR contract definition found for ${contract.symbol ?? contract.conId ?? ""}.`),
        );
      };
      const onError = (error: Error, code: number, responseId: number) => {
        if (responseId !== reqId || code !== 200) return;
        cleanup();
        reject(new Error(`IBKR could not resolve contract: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        api.removeListener(EventName.contractDetails, onDetails);
        api.removeListener(EventName.contractDetailsEnd, onEnd);
        api.removeListener(EventName.error, onError);
      };
      api.on(EventName.contractDetails, onDetails);
      api.on(EventName.contractDetailsEnd, onEnd);
      api.on(EventName.error, onError);
      api.reqContractDetails(reqId, contract);
    });
  }

  private nextId() {
    this.requestId += 1;
    return this.requestId;
  }
}

function normalizeExpiry(value: string | undefined): string | undefined {
  if (!value || !/^\d{6}(\d{2})?$/.test(value)) return undefined;
  if (value.length === 8) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-01`;
}

export function toIbContract(contract: ResolvedContract): Contract {
  return {
    conId: contract.conId,
    symbol: contract.symbol,
    secType: contract.secType === "STK"
      ? SecType.STK
      : contract.secType === "IND"
        ? SecType.IND
        : SecType.FUT,
    exchange: contract.exchange,
    primaryExch: contract.primaryExchange,
    currency: contract.currency,
    lastTradeDateOrContractMonth: contract.lastTradeDate ?? contract.contractMonth,
    multiplier: contract.multiplier === undefined ? undefined : Number(contract.multiplier),
    localSymbol: contract.localSymbol,
  };
}
