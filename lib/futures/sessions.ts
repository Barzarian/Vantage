import { z } from "zod";
import holidayData from "@/data/futures-holidays.json";
import type { FuturesRoot } from "@/lib/market-data/schemas";

const holidayCalendar = z.record(z.string(), z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))).parse(holidayData);
export type FuturesSessionStatus = "open" | "closed" | "maintenance break";

type EasternParts = { date: string; weekday: number; minute: number };

function easternParts(date: Date): EasternParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: weekdays[values.weekday!]!,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function clockMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function schedule(root: FuturesRoot): { openMinute: number; closeMinute: number; breakStart: number; breakEnd: number } {
  const hours = root.tradingHours;
  const open = /Sun\s+(\d{2}:\d{2})/i.exec(hours)?.[1] ?? "18:00";
  const close = /Fri\s+(\d{2}:\d{2})/i.exec(hours)?.[1] ?? "17:00";
  const maintenance = /break\s+(\d{2}:\d{2})-(\d{2}:\d{2})/i.exec(hours);
  return {
    openMinute: clockMinute(open),
    closeMinute: clockMinute(close),
    breakStart: clockMinute(maintenance?.[1] ?? "17:00"),
    breakEnd: clockMinute(maintenance?.[2] ?? "18:00"),
  };
}

export function futuresSessionStatus(root: FuturesRoot, at = new Date()): FuturesSessionStatus {
  const local = easternParts(at);
  if ((holidayCalendar[local.date.slice(0, 4)] ?? []).includes(local.date)) return "closed";
  const hours = schedule(root);
  if (local.weekday === 6) return "closed";
  if (local.weekday === 0 && local.minute < hours.openMinute) return "closed";
  if (local.weekday === 5 && local.minute >= hours.closeMinute) return "closed";
  if (local.minute >= hours.breakStart && local.minute < hours.breakEnd) return "maintenance break";
  return "open";
}

export function futuresTradeDate(root: FuturesRoot, at = new Date()): string {
  const local = easternParts(at);
  const hours = schedule(root);
  const date = new Date(`${local.date}T12:00:00Z`);
  if (local.weekday === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  } else if (local.weekday === 6) {
    date.setUTCDate(date.getUTCDate() + 2);
  } else if (local.weekday === 5 && local.minute >= hours.closeMinute) {
    date.setUTCDate(date.getUTCDate() + 3);
  } else if (local.weekday < 5 && local.minute >= hours.openMinute) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || isFuturesHoliday(date.toISOString().slice(0, 10))) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

export function isFuturesHoliday(date: string): boolean {
  return (holidayCalendar[date.slice(0, 4)] ?? []).includes(date);
}
