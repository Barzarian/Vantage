import { FuturesDashboard } from "@/components/futures-dashboard";

export default async function FuturesRootPage({ params }: { params: Promise<{ root: string }> }) {
  const { root } = await params;
  return <FuturesDashboard root={decodeURIComponent(root)} />;
}
