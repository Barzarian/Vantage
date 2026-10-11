import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vantage — Market Terminal",
  description: "A focused market monitoring terminal for stocks, futures, and options.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
