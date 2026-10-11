import { ChartWorkspace } from "@/components/chart-workspace";

export default async function ChartPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <ChartWorkspace symbol={decodeURIComponent(symbol).slice(0, 32)} />;
}
