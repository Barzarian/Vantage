import { and, asc, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { accounts, portfolioSnapshots, savedPositionsPreferences, transactionAudit, transactions } from "@/db/schema";
import {
  accountSchema,
  accountSettingsSchema,
  portfolioSnapshotSchema,
  positionsPreferencesSchema,
  transactionInputSchema,
  transactionSchema,
  type PositionAccount,
  type AccountSettings,
  type PositionTransaction,
  type PortfolioSnapshot,
  type PositionsPreferences,
} from "./model";

const DEFAULT_USER_ID = "local-user";

type AuditEvent = {
  id: string;
  transactionId: string;
  action: "create" | "update" | "delete";
  before: PositionTransaction | null;
  after: PositionTransaction | null;
  createdAt: string;
};

type LocalLedger = {
  account: PositionAccount;
  transactions: PositionTransaction[];
  audit: AuditEvent[];
  snapshots: PortfolioSnapshot[];
  preferences: PositionsPreferences;
};

declare global {
  var localPositionLedgers: Map<string, LocalLedger> | undefined;
}

export class PositionServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PositionServiceError";
  }
}

export async function getPositionsData(userId = DEFAULT_USER_ID): Promise<{
  account: PositionAccount;
  transactions: PositionTransaction[];
  audit: AuditEvent[];
  snapshots: PortfolioSnapshot[];
  preferences: PositionsPreferences;
}> {
  const account = await ensureAccount(userId);
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    return {
      account,
      transactions: [...ledger.transactions],
      audit: [...ledger.audit],
      snapshots: [...ledger.snapshots],
      preferences: ledger.preferences,
    };
  }
  const [rows, auditRows, snapshotRows, preferenceRows] = await Promise.all([
    database.db.select().from(transactions)
      .where(eq(transactions.accountId, account.id))
      .orderBy(asc(transactions.executedAt), asc(transactions.id)),
    database.db.select().from(transactionAudit)
      .where(eq(transactionAudit.accountId, account.id))
      .orderBy(desc(transactionAudit.createdAt)).limit(100),
    database.db.select().from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.accountId, account.id)).orderBy(asc(portfolioSnapshots.snapshotDate)),
    database.db.select().from(savedPositionsPreferences).where(eq(savedPositionsPreferences.userId, userId)).limit(1),
  ]);
  return {
    account,
    transactions: rows.map(mapDatabaseTransaction),
    audit: auditRows.map((row) => ({
      id: row.id,
      transactionId: row.transactionId,
      action: row.action as AuditEvent["action"],
      before: row.before ? transactionSchema.parse(JSON.parse(row.before)) : null,
      after: row.after ? transactionSchema.parse(JSON.parse(row.after)) : null,
      createdAt: row.createdAt.toISOString(),
    })),
    snapshots: snapshotRows.map((row) => portfolioSnapshotSchema.parse({
      accountId: row.accountId,
      snapshotDate: row.snapshotDate,
      marketValue: Number(row.marketValue),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      delta: Number(row.delta),
      gamma: Number(row.gamma),
      theta: Number(row.theta),
      vega: Number(row.vega),
    })),
    preferences: preferenceRows[0]
      ? positionsPreferencesSchema.parse(JSON.parse(preferenceRows[0].preferences))
      : defaultPositionsPreferences(),
  };
}

export async function createPositionTransaction(input: unknown, userId = DEFAULT_USER_ID): Promise<PositionTransaction> {
  const transactionInput = transactionInputSchema.parse(input);
  const account = await ensureAccount(userId);
  if (transactionInput.accountId !== account.id) {
    throw new PositionServiceError("The selected account is not available.", 404);
  }
  const transaction = transactionSchema.parse({ ...transactionInput, id: crypto.randomUUID() });
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    ledger.transactions.push(transaction);
    ledger.audit.unshift(makeAudit(transaction.id, "create", null, transaction));
    return transaction;
  }
  await database.db.insert(transactions).values(toDatabaseValues(transaction));
  await insertAudit(account.id, transaction.id, "create", null, transaction);
  return transaction;
}

export async function updatePositionTransaction(id: string, input: unknown, userId = DEFAULT_USER_ID): Promise<PositionTransaction> {
  const transactionInput = transactionInputSchema.parse(input);
  const account = await ensureAccount(userId);
  if (transactionInput.accountId !== account.id) {
    throw new PositionServiceError("The selected account is not available.", 404);
  }
  const transaction = transactionSchema.parse({ ...transactionInput, id });
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    const index = ledger.transactions.findIndex((item) => item.id === id && item.accountId === account.id);
    if (index < 0) throw new PositionServiceError("Transaction not found.", 404);
    const before = ledger.transactions[index]!;
    ledger.transactions[index] = transaction;
    ledger.audit.unshift(makeAudit(id, "update", before, transaction));
    return transaction;
  }
  const existing = await database.db.select().from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.accountId, account.id))).limit(1);
  if (!existing[0]) throw new PositionServiceError("Transaction not found.", 404);
  const before = mapDatabaseTransaction(existing[0]);
  await database.db.update(transactions).set({
    ...toDatabaseValues(transaction),
    createdAt: existing[0].createdAt,
    updatedAt: new Date(),
  }).where(and(eq(transactions.id, id), eq(transactions.accountId, account.id)));
  await insertAudit(account.id, id, "update", before, transaction);
  return transaction;
}

export async function deletePositionTransaction(id: string, userId = DEFAULT_USER_ID): Promise<void> {
  const account = await ensureAccount(userId);
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    const index = ledger.transactions.findIndex((item) => item.id === id && item.accountId === account.id);
    if (index < 0) throw new PositionServiceError("Transaction not found.", 404);
    const [before] = ledger.transactions.splice(index, 1);
    ledger.audit.unshift(makeAudit(id, "delete", before!, null));
    return;
  }
  const existing = await database.db.select().from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.accountId, account.id))).limit(1);
  if (!existing[0]) throw new PositionServiceError("Transaction not found.", 404);
  const before = mapDatabaseTransaction(existing[0]);
  await database.db.delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.accountId, account.id)));
  await insertAudit(account.id, id, "delete", before, null);
}

export async function updatePositionAccount(input: unknown, userId = DEFAULT_USER_ID): Promise<PositionAccount> {
  const settings: AccountSettings = accountSettingsSchema.parse(input);
  const account = await ensureAccount(userId);
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    ledger.account = accountSchema.parse({ ...ledger.account, ...settings });
    return ledger.account;
  }
  await database.db.update(accounts).set({
    ...settings,
    fxRates: settings.fxRates === undefined ? undefined : JSON.stringify(settings.fxRates),
    concentrationThreshold: settings.concentrationThreshold === undefined ? undefined : String(settings.concentrationThreshold),
    cashBalance: settings.cashBalance === undefined ? undefined : String(settings.cashBalance),
  }).where(and(eq(accounts.id, account.id), eq(accounts.userId, userId)));
  const [updated] = await database.db.select().from(accounts).where(eq(accounts.id, account.id)).limit(1);
  if (!updated) throw new Error("Could not read the updated positions account.");
  return mapAccount(updated);
}

export async function savePortfolioSnapshot(input: unknown, userId = DEFAULT_USER_ID): Promise<PortfolioSnapshot> {
  const snapshot = portfolioSnapshotSchema.parse(input);
  const account = await ensureAccount(userId);
  if (snapshot.accountId !== account.id) throw new PositionServiceError("The selected account is not available.", 404);
  const database = getDatabase();
  if (!database) {
    const ledger = getLocalLedger(userId);
    const index = ledger.snapshots.findIndex((item) => item.snapshotDate === snapshot.snapshotDate);
    if (index < 0) ledger.snapshots.push(snapshot);
    else ledger.snapshots[index] = snapshot;
    return snapshot;
  }
  const values = {
    marketValue: String(snapshot.marketValue),
    realizedPnl: String(snapshot.realizedPnl),
    unrealizedPnl: String(snapshot.unrealizedPnl),
    delta: String(snapshot.delta),
    gamma: String(snapshot.gamma),
    theta: String(snapshot.theta),
    vega: String(snapshot.vega),
  };
  await database.db.insert(portfolioSnapshots).values({
    id: crypto.randomUUID(),
    accountId: snapshot.accountId,
    snapshotDate: snapshot.snapshotDate,
    ...values,
  }).onConflictDoUpdate({
    target: [portfolioSnapshots.accountId, portfolioSnapshots.snapshotDate],
    set: values,
  });
  return snapshot;
}

export async function savePositionsPreferences(input: unknown, userId = DEFAULT_USER_ID): Promise<PositionsPreferences> {
  const preferences = positionsPreferencesSchema.parse(input);
  const database = getDatabase();
  if (!database) {
    getLocalLedger(userId).preferences = preferences;
    return preferences;
  }
  const serialized = JSON.stringify(preferences);
  await database.db.insert(savedPositionsPreferences).values({
    userId,
    preferences: serialized,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: savedPositionsPreferences.userId,
    set: { preferences: serialized, updatedAt: new Date() },
  });
  return preferences;
}

async function ensureAccount(userId: string): Promise<PositionAccount> {
  const database = getDatabase();
  if (!database) return getLocalLedger(userId).account;
  const [existing] = await database.db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
  if (existing) return mapAccount(existing);

  await database.db.insert(accounts).values({
    id: crypto.randomUUID(),
    userId,
    name: "Primary account",
    baseCurrency: "USD",
    lotMethod: "fifo",
    expiryWarningDays: 7,
    concentrationThreshold: "0.25",
    fxRates: "{}",
    cashBalance: "0",
  }).onConflictDoNothing();
  const [created] = await database.db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
  if (!created) throw new Error("Could not create the default positions account.");
  return mapAccount(created);
}

function getLocalLedger(userId = DEFAULT_USER_ID): LocalLedger {
  globalThis.localPositionLedgers ??= new Map();
  let ledger = globalThis.localPositionLedgers.get(userId);
  if (!ledger) {
    const accountId = userId === DEFAULT_USER_ID
      ? "local-account"
      : `local-account-${userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`;
    ledger = {
    account: accountSchema.parse({
      id: accountId,
      userId,
      name: "Primary account",
      baseCurrency: "USD",
      fxRates: {},
      cashBalance: 0,
      lotMethod: "fifo",
      expiryWarningDays: 7,
      concentrationThreshold: 0.25,
    }),
    transactions: [],
    audit: [],
    snapshots: [],
    preferences: defaultPositionsPreferences(),
    };
    globalThis.localPositionLedgers.set(userId, ledger);
  }
  ledger.account = accountSchema.parse(ledger.account);
  ledger.snapshots ??= [];
  ledger.preferences ??= defaultPositionsPreferences();
  return ledger;
}

function defaultPositionsPreferences(): PositionsPreferences {
  return positionsPreferencesSchema.parse({
    columns: ["symbol", "assetClass", "quantity", "averageCost", "mark", "marketValue", "dayPnl", "unrealizedPnl", "delta", "portfolioWeight", "daysToExpiry"],
    sortBy: "symbol",
  });
}

function mapAccount(row: typeof accounts.$inferSelect): PositionAccount {
  return accountSchema.parse({
    id: row.id,
    userId: row.userId,
    name: row.name,
    baseCurrency: row.baseCurrency,
    fxRates: parseFxRates(row.fxRates),
    cashBalance: Number(row.cashBalance),
    lotMethod: row.lotMethod,
    expiryWarningDays: row.expiryWarningDays,
    concentrationThreshold: Number(row.concentrationThreshold),
  });
}

function parseFxRates(value: string): Record<string, number> {
  const rates: unknown = JSON.parse(value);
  if (typeof rates !== "object" || rates === null || Array.isArray(rates)) {
    throw new Error("Stored account FX rates are invalid.");
  }
  return rates as Record<string, number>;
}

function mapDatabaseTransaction(row: typeof transactions.$inferSelect): PositionTransaction {
  const base = {
    id: row.id,
    accountId: row.accountId,
    symbol: row.symbol,
    assetClass: row.assetClass,
    executedAt: row.executedAt.toISOString(),
    notes: row.notes,
  };
  if (row.kind === "split") {
    return transactionSchema.parse({
      ...base,
      kind: row.kind,
      assetClass: "equity",
      ratioNumerator: Number(row.ratioNumerator),
      ratioDenominator: Number(row.ratioDenominator),
    });
  }
  if (row.kind === "dividend") {
    return transactionSchema.parse({
      ...base,
      kind: row.kind,
      assetClass: "equity",
      amountPerShare: Number(row.amountPerShare),
      currency: row.currency,
    });
  }
  if (row.kind === "option-outcome") {
    return transactionSchema.parse({
      ...base,
      kind: row.kind,
      assetClass: "option",
      disposition: row.disposition,
    });
  }
  return transactionSchema.parse({
    ...base,
    kind: "trade",
    side: row.side,
    quantity: Number(row.quantity),
    price: Number(row.price),
    fees: Number(row.fees),
    currency: row.currency,
    openClose: row.openClose,
  });
}

function toDatabaseValues(transaction: PositionTransaction) {
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    symbol: transaction.symbol,
    assetClass: transaction.assetClass,
    kind: transaction.kind,
    side: transaction.kind === "trade" ? transaction.side : null,
    quantity: transaction.kind === "trade" ? String(transaction.quantity) : null,
    price: transaction.kind === "trade" ? String(transaction.price) : null,
    fees: transaction.kind === "trade" ? String(transaction.fees) : "0",
    currency: transaction.kind === "trade" || transaction.kind === "dividend" ? transaction.currency : "USD",
    executedAt: new Date(transaction.executedAt),
    openClose: transaction.kind === "trade" ? transaction.openClose ?? null : null,
    notes: transaction.notes,
    ratioNumerator: transaction.kind === "split" ? String(transaction.ratioNumerator) : null,
    ratioDenominator: transaction.kind === "split" ? String(transaction.ratioDenominator) : null,
    amountPerShare: transaction.kind === "dividend" ? String(transaction.amountPerShare) : null,
    disposition: transaction.kind === "option-outcome" ? transaction.disposition : null,
    updatedAt: new Date(),
  };
}

async function insertAudit(
  accountId: string,
  transactionId: string,
  action: AuditEvent["action"],
  before: PositionTransaction | null,
  after: PositionTransaction | null,
): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  await database.db.insert(transactionAudit).values({
    id: crypto.randomUUID(),
    transactionId,
    accountId,
    action,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
  });
}

function makeAudit(
  transactionId: string,
  action: AuditEvent["action"],
  before: PositionTransaction | null,
  after: PositionTransaction | null,
): AuditEvent {
  return {
    id: crypto.randomUUID(),
    transactionId,
    action,
    before,
    after,
    createdAt: new Date().toISOString(),
  };
}
