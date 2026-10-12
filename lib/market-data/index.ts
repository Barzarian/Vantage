import { env } from "./env";
import { MockMarketDataProvider } from "./mock-provider";
import type { MarketDataProvider } from "./provider";
import { IbkrProvider } from "@/lib/providers/ibkr-provider";

const globalForMarketData = globalThis as typeof globalThis & {
  mockMarketDataProvider?: MockMarketDataProvider;
  ibkrProvider?: IbkrProvider;
};

export function getMarketDataProvider(): MarketDataProvider {
  if (env.MARKET_DATA_PROVIDER === "mock") {
    if (
      !globalForMarketData.mockMarketDataProvider ||
      typeof globalForMarketData.mockMarketDataProvider.getFuturesRoots !== "function"
    ) {
      globalForMarketData.mockMarketDataProvider = new MockMarketDataProvider();
    }
    return globalForMarketData.mockMarketDataProvider;
  }

  if (
    !globalForMarketData.ibkrProvider ||
    typeof globalForMarketData.ibkrProvider.getFuturesContracts !== "function"
  ) {
    globalForMarketData.ibkrProvider = new IbkrProvider();
  }
  return globalForMarketData.ibkrProvider;
}
