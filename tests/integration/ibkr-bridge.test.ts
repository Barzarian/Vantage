import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../../services/ibkr-bridge/src/config";
import { loadConfig } from "../../services/ibkr-bridge/src/config";
import { IbkrConnection } from "../../services/ibkr-bridge/src/connection";
import {
  ContractResolver,
  MemoryContractStore,
} from "../../services/ibkr-bridge/src/contracts";
import { HistoricalDataService, MemoryHistoricalBarCache } from "../../services/ibkr-bridge/src/history";
import {
  MarketDataSubscriptions,
  type NormalizedQuote,
} from "../../services/ibkr-bridge/src/streaming";

class FakeTwsClient extends EventEmitter {
  readonly marketDataRequests: number[] = [];
  readonly cancelledMarketData: number[] = [];
  historicalRequests = 0;

  constructor(private readonly connectOnStart = false) {
    super();
  }

  connect() {
    if (this.connectOnStart) queueMicrotask(() => this.emit("connected"));
    return this;
  }

  disconnect() {
    this.emit("disconnected");
    return this;
  }

  reqMarketDataType() {
    return this;
  }

  reqMatchingSymbols(reqId: number, pattern: string) {
    queueMicrotask(() =>
      this.emit("symbolSamples", reqId, [
        {
          contract: {
            symbol: pattern,
            secType: "STK",
            exchange: "SMART",
            primaryExch: "NASDAQ",
            currency: "USD",
          },
        },
      ]),
    );
    return this;
  }

  reqContractDetails(reqId: number, candidate: { symbol?: string; conId?: number }) {
    queueMicrotask(() => {
      this.emit("contractDetails", reqId, {
        contract: {
          conId: candidate.conId ?? 265598,
          symbol: candidate.symbol ?? "AAPL",
          localSymbol: candidate.symbol ?? "AAPL",
          secType: "STK",
          exchange: "SMART",
          primaryExch: "NASDAQ",
          currency: "USD",
        },
        longName: "Apple Inc.",
        minTick: 0.01,
        tradingHours: "20261011:0930-20261011:1600",
        timeZoneId: "America/New_York",
      });
      this.emit("contractDetailsEnd", reqId);
    });
    return this;
  }

  reqMktData(reqId: number) {
    this.marketDataRequests.push(reqId);
    return this;
  }

  cancelMktData(reqId: number) {
    this.cancelledMarketData.push(reqId);
    return this;
  }

  reqHistoricalData(reqId: number) {
    this.historicalRequests += 1;
    queueMicrotask(() => {
      this.emit("historicalData", reqId, "1800000000", 100, 102, 99, 101, 800, 10, 100.5, false);
      this.emit("historicalData", reqId, "finished-20261011-20261011", -1, -1, -1, -1, -1, -1, -1, false);
    });
    return this;
  }

  emitError(code: number, reqId: number, message = "fixture error") {
    this.emit("error", new Error(message), code, reqId);
  }

  emitLiveQuote(reqId: number) {
    this.emit("tickPrice", reqId, 9, 100, {});
    this.emit("tickPrice", reqId, 4, 102, {});
    this.emit("tickPrice", reqId, 1, 101.9, {});
    this.emit("tickSize", reqId, 0, 15);
    this.emit("tickSize", reqId, 5, 3);
  }
}

const config: BridgeConfig = loadConfig({
  IB_HOST: "127.0.0.1",
  IB_PORT: "4002",
  IB_CLIENT_ID: "41",
  IB_MARKET_DATA_TYPE: "3",
  IB_READ_ONLY: "true",
  IBKR_BRIDGE_HOST: "127.0.0.1",
  IBKR_BRIDGE_PORT: "8787",
  IBKR_BRIDGE_TOKEN: "integration-tests-bridge-secret-123456789",
  DATABASE_URL: "postgres://vantage:vantage@127.0.0.1:5433/vantage",
});

function contractsFor(api: FakeTwsClient, store = new MemoryContractStore()) {
  return new ContractResolver(() => api as never, store);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IBKR bridge against a fake TWS socket", () => {
  it("resolves and caches contract listings, then merges recorded tick fields", async () => {
    const api = new FakeTwsClient();
    const store = new MemoryContractStore();
    const resolver = contractsFor(api, store);
    const [contract] = await resolver.search("AAPL");
    expect(contract).toMatchObject({
      conId: 265598,
      symbol: "AAPL",
      secType: "STK",
      exchange: "SMART",
      primaryExchange: "NASDAQ",
      currency: "USD",
      minTick: 0.01,
    });
    expect(await resolver.byConId(265598)).toEqual(contract);

    const subscriptions = new MarketDataSubscriptions(() => api as never, 10, "realtime");
    let latest: NormalizedQuote | undefined;
    subscriptions.subscribe(contract!, (quote) => { latest = quote; });
    const reqId = api.marketDataRequests[0]!;
    api.emitLiveQuote(reqId);

    expect(latest).toMatchObject({
      last: 102,
      bid: 101.9,
      bidSize: 15,
      lastSize: 3,
      prevClose: 100,
      change: 2,
      changePercent: 2,
    });
    subscriptions.dispose();
  });

  it("surfaces permission failures and tags delayed-data error/tick fixtures", async () => {
    const api = new FakeTwsClient();
    const resolver = contractsFor(api);
    const [contract] = await resolver.search("AAPL");
    const subscriptions = new MarketDataSubscriptions(() => api as never, 10, "realtime");
    const errors: Array<{ code: number; conId?: number }> = [];
    subscriptions.onError((error) => errors.push(error));
    let latest: NormalizedQuote | undefined;
    subscriptions.subscribe(contract!, (quote) => { latest = quote; });
    const reqId = api.marketDataRequests[0]!;

    api.emitError(354, reqId, "Market data is not subscribed");
    expect(errors).toContainEqual(expect.objectContaining({ code: 354, conId: 265598 }));
    api.emitError(10167, reqId, "Displaying delayed market data");
    api.emit("tickPrice", reqId, 68, 99.5, {});
    expect(latest?.dataType).toBe("delayed");
    expect(latest?.last).toBe(99.5);
    subscriptions.dispose();
  });

  it("returns fixture historical bars through the paced request service", async () => {
    const api = new FakeTwsClient();
    const resolver = contractsFor(api);
    const [contract] = await resolver.search("AAPL");
    const service = new HistoricalDataService(() => api as never, new MemoryHistoricalBarCache());

    const bars = await service.getBars(contract!, "1m", 1_799_999_900, 1_800_000_100);
    expect(bars).toEqual([
      { time: 1_800_000_000, open: 100, high: 102, low: 99, close: 101, volume: 800 },
    ]);
    expect(api.historicalRequests).toBe(1);
    expect(service.queue.queuedRequests).toBe(0);
  });

  it("reconnects after disconnect and re-requests every active quote line", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const clients: FakeTwsClient[] = [];
    const connection = new IbkrConnection(config, () => {
      const client = new FakeTwsClient(true);
      clients.push(client);
      return client as never;
    });
    const subscriptions = new MarketDataSubscriptions(() => connection.getClient(), 10, "realtime");
    connection.on("state", (state: string) => {
      if (state === "live") subscriptions.resubscribe();
    });
    const resolved = await contractsFor(new FakeTwsClient()).search("AAPL");

    connection.start();
    await vi.waitFor(() => expect(connection.getHealth().state).toBe("live"));
    subscriptions.subscribe(resolved[0]!, () => {});
    expect(clients[0]?.marketDataRequests).toHaveLength(1);

    clients[0]?.emit("disconnected");
    expect(connection.getHealth().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(connection.getHealth().state).toBe("live"));
    expect(clients[1]?.marketDataRequests).toHaveLength(1);

    subscriptions.dispose();
    connection.stop();
  });
});
