import { EventEmitter } from "node:events";
import { EventName, IBApi } from "@stoqey/ib";
import type { BridgeConfig } from "./config.js";

export type ConnectionState = "disconnected" | "connecting" | "reconnecting" | "live";

export class IbkrConnection extends EventEmitter {
  private api: IBApi | undefined;
  private state: ConnectionState = "disconnected";
  private lastError: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = false;
  private hasConnected = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly createApi: (config: BridgeConfig) => IBApi = (settings) =>
      new IBApi({
        host: settings.IB_HOST,
        port: settings.IB_PORT,
        clientId: settings.IB_CLIENT_ID,
      }),
  ) {
    super();
  }

  start(): void {
    if (this.state !== "disconnected" || this.stopped) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const api = this.api;
    this.api = undefined;
    if (api) {
      api.removeAllListeners();
      api.disconnect();
    }
    this.setState("disconnected");
  }

  getClient(): IBApi {
    if (!this.api || this.state !== "live") {
      throw new Error("IBKR Gateway is not connected.");
    }
    return this.api;
  }

  getHealth() {
    return {
      state: this.state,
      marketDataType: this.config.IB_MARKET_DATA_TYPE,
      activeLines: 0,
      queuedHistoricalRequests: 0,
      lastError: this.lastError,
      readOnly: true as const,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.reconnectAttempt === 0 && !this.api ? "connecting" : "reconnecting");
    const oldApi = this.api;
    this.api = undefined;
    if (oldApi) {
      oldApi.removeAllListeners();
      oldApi.disconnect();
    }
    const api = this.createApi(this.config);
    this.api = api;
    api.on(EventName.connected, () => {
      if (this.stopped || this.api !== api) return;
      this.lastError = undefined;
      this.reconnectAttempt = 0;
      this.setState("live");
      api.reqMarketDataType(this.config.IB_MARKET_DATA_TYPE);
      if (this.hasConnected) this.emit("reconnected");
      this.hasConnected = true;
    });
    api.on(EventName.disconnected, () => {
      if (this.stopped || this.api !== api) return;
      this.lastError = "Connection to IB Gateway was lost. Reconnecting automatically.";
      this.setState("reconnecting");
      this.scheduleReconnect();
    });
    api.on(EventName.error, (error: Error, code: number) => {
      if (this.stopped || this.api !== api) return;
      if (code === 2104 || code === 2106 || code === 2158) {
        console.info(`[ibkr] farm status ${code}`);
        return;
      }
      const message = redactSensitive(error.message);
      if (code === 1100) {
        this.lastError = "IB Gateway lost connectivity to IBKR. Waiting for the connection to recover.";
        this.setState("reconnecting");
        this.scheduleReconnect();
      } else if (code === 1101 || code === 1102) {
        this.lastError = undefined;
        this.setState("live");
        if (code === 1101) this.emit("resubscribe");
      } else if (code === 10167) {
        this.emit("ibError", { code, message, action: "Delayed data is being displayed." });
      } else if (code === 10168) {
        this.lastError = "Delayed market data is not available for this instrument.";
        this.emit("ibError", { code, message, action: "Check the instrument's exchange permissions or market-data subscriptions." });
      } else if (code === 326) {
        this.lastError = "IBKR client ID is already in use. Use a unique IB_CLIENT_ID for this connection.";
        this.setState("reconnecting");
        this.emit("ibError", {
          code,
          message,
          action: "This API client ID is already connected. Also, IBKR allows only one active username session; sign out elsewhere or use a separate secondary username for the API.",
        });
        this.scheduleReconnect();
      } else {
        if (code === 502) {
          this.lastError = "Could not connect to IB Gateway. Verify that Gateway is running and API socket access is enabled.";
          this.setState("reconnecting");
          this.scheduleReconnect();
        } else if (code === 354 || code === 200) {
          this.emit("ibError", {
            code,
            message,
            action:
              code === 354
                ? "Market data is not subscribed. Add the relevant IBKR subscription or set IB_MARKET_DATA_TYPE=3."
                : "No security definition found. Refine the symbol or select an exchange listing.",
          });
        } else {
          this.lastError = `[${code}] ${message}`;
          console.error(`[ibkr] error ${code}: ${message}`);
          this.emit("ibError", { code, message });
        }
      }
    });
    try {
      api.connect();
    } catch (error) {
      this.lastError = `Could not start IBKR connection: ${redactSensitive(error instanceof Error ? error.message : "unknown error")}`;
      this.setState("reconnecting");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const baseDelay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.emit("state", state);
  }
}

function redactSensitive(message: string): string {
  return message.replace(/\b(?:DU|U)\d{6,}\b/gi, "[account]");
}
