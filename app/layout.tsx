import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { AlertsUnreadBell } from "@/components/alerts-unread-bell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vantage — Market Terminal",
  description: "A focused market monitoring terminal for stocks, futures, and options.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body><Providers>{children}<AlertsUnreadBell /></Providers></body>
    </html>
  );
}
