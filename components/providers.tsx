"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 2_000, refetchOnWindowFocus: false, retry: 1 },
      mutations: { retry: 0 },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
