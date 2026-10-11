import { z } from "zod";

const envSchema = z.object({
  MARKET_DATA_PROVIDER: z.enum(["mock", "alpaca"]).default("mock"),
  ALPACA_API_KEY: z.string().optional(),
  ALPACA_API_SECRET: z.string().optional(),
  ALPACA_DATA_URL: z.string().url().default("https://data.alpaca.markets"),
});

export const env = envSchema.parse({
  MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
  ALPACA_API_KEY: process.env.ALPACA_API_KEY,
  ALPACA_API_SECRET: process.env.ALPACA_API_SECRET,
  ALPACA_DATA_URL: process.env.ALPACA_DATA_URL,
});
