import { getMarketDataProvider } from "@/lib/market-data";
import { MarketTerminal } from "@/components/market-terminal";

const WATCHLIST = ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN", "ES", "CL"];
const STRIP = ["SPX", "NDX", "DJI", "VIX", "ES", "NQ", "CL", "GC", "DXY", "10Y"];

export default async function HomePage() {
  const provider = getMarketDataProvider();
  const [watchQuotes, stripQuotes] = await Promise.all([
    provider.getQuote(WATCHLIST),
    provider.getQuote(STRIP),
  ]);
  return <MarketTerminal initialQuotes={watchQuotes} initialStrip={stripQuotes} />;
}
