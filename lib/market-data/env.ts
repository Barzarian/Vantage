import { z } from "zod";

const envSchema = z.object({
  MARKET_DATA_PROVIDER: z.enum(["mock", "ibkr"]).default("mock"),
  IBKR_BRIDGE_URL: z.string().url().default("http://127.0.0.1:8787"),
  IBKR_BRIDGE_TOKEN: z.string().optional(),
  ALPACA_API_KEY: z.string().optional(),
  ALPACA_API_SECRET: z.string().optional(),
  ALPACA_DATA_URL: z.string().url().default("https://data.alpaca.markets"),
}).superRefine((values, context) => {
  if (values.MARKET_DATA_PROVIDER === "ibkr" && (!values.IBKR_BRIDGE_TOKEN || values.IBKR_BRIDGE_TOKEN.length < 32)) {
    context.addIssue({
      code: "custom",
      path: ["IBKR_BRIDGE_TOKEN"],
      message: "IBKR_BRIDGE_TOKEN must contain at least 32 characters when MARKET_DATA_PROVIDER=ibkr.",
    });
  }
});

export const env = envSchema.parse({
  MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
  IBKR_BRIDGE_URL: process.env.IBKR_BRIDGE_URL,
  IBKR_BRIDGE_TOKEN: process.env.IBKR_BRIDGE_TOKEN,
  ALPACA_API_KEY: process.env.ALPACA_API_KEY,
  ALPACA_API_SECRET: process.env.ALPACA_API_SECRET,
  ALPACA_DATA_URL: process.env.ALPACA_DATA_URL,
});
