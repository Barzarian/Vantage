import { z } from "zod";

const configSchema = z.object({
  IB_HOST: z.string().min(1).default("127.0.0.1"),
  IB_PORT: z.coerce.number().int().min(1).max(65535).default(4002),
  IB_CLIENT_ID: z.coerce.number().int().min(1).max(2_147_483_647).default(41),
  IB_MARKET_DATA_TYPE: z.coerce.number().int().min(1).max(4).default(3),
  IB_MARKET_DATA_LINE_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  IB_MARKET_DATA_LRU_EVICT: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  IB_USE_RTH_EQUITIES: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  IB_READ_ONLY: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  IBKR_BRIDGE_HOST: z.string().default("127.0.0.1"),
  IBKR_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  IBKR_BRIDGE_TOKEN: z.string().min(32, "IBKR_BRIDGE_TOKEN must contain at least 32 characters."),
  DATABASE_URL: z.string().url(),
});

export type BridgeConfig = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): BridgeConfig {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid IBKR bridge configuration: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.IB_READ_ONLY !== true) {
    throw new Error("IB_READ_ONLY=false is not supported; the bridge is read-only.");
  }
  if (
    parsed.data.IBKR_BRIDGE_HOST !== "127.0.0.1" &&
    parsed.data.IBKR_BRIDGE_HOST !== "::1" &&
    parsed.data.IBKR_BRIDGE_HOST !== "localhost"
  ) {
    throw new Error("The IBKR bridge must bind to localhost. Use a private network tunnel to access it remotely.");
  }
  return parsed.data;
}
