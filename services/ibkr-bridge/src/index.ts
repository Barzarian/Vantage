import { loadConfig } from "./config.js";
import { IbkrConnection } from "./connection.js";
import { ContractResolver, PostgresContractStore } from "./contracts.js";
import { mapMarketDataType, MarketDataSubscriptions } from "./streaming.js";
import {
  HistoricalDataService,
  PostgresHistoricalBarCache,
} from "./history.js";
import { createBridgeServer } from "./server.js";

const config = loadConfig();
const connection = new IbkrConnection(config);
const store = new PostgresContractStore(config.DATABASE_URL);
await store.initialize();
const historyCache = new PostgresHistoricalBarCache(config.DATABASE_URL);
await historyCache.initialize();
const resolver = new ContractResolver(() => connection.getClient(), store);
const subscriptions = new MarketDataSubscriptions(
  () => connection.getClient(),
  config.IB_MARKET_DATA_LINE_LIMIT,
  mapMarketDataType(config.IB_MARKET_DATA_TYPE),
  config.IB_MARKET_DATA_LRU_EVICT,
);
const history = new HistoricalDataService(
  () => connection.getClient(),
  historyCache,
  undefined,
  config.IB_USE_RTH_EQUITIES,
);
const server = createBridgeServer(config, connection, resolver, subscriptions, history);
connection.on("state", (state: string) => {
  if (state === "live") subscriptions.resubscribe();
});
connection.on("reconnected", () => void subscriptions.recoverBars(history));
connection.on("resubscribe", () => {
  subscriptions.resubscribe();
  void subscriptions.recoverBars(history);
});

server.listen(config.IBKR_BRIDGE_PORT, config.IBKR_BRIDGE_HOST, () => {
  console.info(`[ibkr] bridge listening on ${config.IBKR_BRIDGE_HOST}:${config.IBKR_BRIDGE_PORT}`);
  connection.start();
});

function shutdown(): void {
  subscriptions.dispose();
  void historyCache.close();
  connection.stop();
  void Promise.all([store.close(), historyCache.close()]).catch((error: unknown) => {
    console.error(`[ibkr] failed to close database clients: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  server.close((error) => {
    if (error) {
      console.error(`[ibkr] bridge shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
