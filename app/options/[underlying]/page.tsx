import { notFound } from "next/navigation";
import { OptionsDashboard } from "@/components/options-dashboard";

export default async function OptionsPage({
  params,
}: {
  params: Promise<{ underlying: string }>;
}) {
  const { underlying } = await params;
  if (!/^[a-zA-Z0-9.]{1,16}$/.test(underlying)) notFound();
  return <OptionsDashboard underlying={underlying} />;
}
