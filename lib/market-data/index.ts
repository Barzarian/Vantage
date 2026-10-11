import { env } from "./env";
import { MockMarketDataProvider } from "./mock-provider";
import type { MarketDataProvider } from "./provider";

const globalForMarketData = globalThis as typeof globalThis & {
  mockMarketDataProvider?: MockMarketDataProvider;
};

export function getMarketDataProvider(): MarketDataProvider {
  if (env.MARKET_DATA_PROVIDER === "mock") {
    globalForMarketData.mockMarketDataProvider ??= new MockMarketDataProvider();
    return globalForMarketData.mockMarketDataProvider;
  }

  throw new Error("MARKET_DATA_PROVIDER=alpaca is not available yet.");
}
