import { z } from "zod";

const envSchema = z.object({
  MARKET_DATA_PROVIDER: z.enum(["mock", "ibkr"]).default("mock"),
  IBKR_BRIDGE_URL: z.string().url().default("http://127.0.0.1:8787"),
  IBKR_BRIDGE_TOKEN: z.string().optional(),
  ALPACA_API_KEY: z.string().optional(),
  ALPACA_API_SECRET: z.string().optional(),
  ALPACA_DATA_URL: z.string().url().default("https://data.alpaca.markets"),
  ALERTS_ENCRYPTION_KEY: z.string().optional(),
  ALERTS_VAPID_PUBLIC_KEY: z.string().optional(),
  ALERTS_VAPID_PRIVATE_KEY: z.string().optional(),
  ALERTS_VAPID_SUBJECT: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  ALERTS_EMAIL_FROM: z.string().email().optional(),
}).superRefine((values, context) => {
  if (values.MARKET_DATA_PROVIDER === "ibkr" && (!values.IBKR_BRIDGE_TOKEN || values.IBKR_BRIDGE_TOKEN.length < 32)) {
    context.addIssue({
      code: "custom",
      path: ["IBKR_BRIDGE_TOKEN"],
      message: "IBKR_BRIDGE_TOKEN must contain at least 32 characters when MARKET_DATA_PROVIDER=ibkr.",
    });
  }
  if (values.ALERTS_ENCRYPTION_KEY) {
    try {
      if (Buffer.from(values.ALERTS_ENCRYPTION_KEY, "base64").length !== 32) throw new Error();
    } catch {
      context.addIssue({
        code: "custom",
        path: ["ALERTS_ENCRYPTION_KEY"],
        message: "ALERTS_ENCRYPTION_KEY must be base64-encoded 32-byte key material.",
      });
    }
  }
  if (Boolean(values.ALERTS_VAPID_PUBLIC_KEY) !== Boolean(values.ALERTS_VAPID_PRIVATE_KEY)) {
    context.addIssue({
      code: "custom",
      path: ["ALERTS_VAPID_PRIVATE_KEY"],
      message: "Both VAPID keys must be configured together.",
    });
  }
  if (values.ALERTS_VAPID_PUBLIC_KEY && !values.ALERTS_VAPID_SUBJECT) {
    context.addIssue({
      code: "custom",
      path: ["ALERTS_VAPID_SUBJECT"],
      message: "ALERTS_VAPID_SUBJECT is required when Web Push keys are configured.",
    });
  }
  if (Boolean(values.RESEND_API_KEY) !== Boolean(values.ALERTS_EMAIL_FROM)) {
    context.addIssue({
      code: "custom",
      path: ["ALERTS_EMAIL_FROM"],
      message: "RESEND_API_KEY and ALERTS_EMAIL_FROM must be configured together.",
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
  ALERTS_ENCRYPTION_KEY: process.env.ALERTS_ENCRYPTION_KEY,
  ALERTS_VAPID_PUBLIC_KEY: process.env.ALERTS_VAPID_PUBLIC_KEY,
  ALERTS_VAPID_PRIVATE_KEY: process.env.ALERTS_VAPID_PRIVATE_KEY,
  ALERTS_VAPID_SUBJECT: process.env.ALERTS_VAPID_SUBJECT,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ALERTS_EMAIL_FROM: process.env.ALERTS_EMAIL_FROM,
});
