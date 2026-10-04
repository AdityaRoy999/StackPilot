"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";

import { ThemeProvider } from "next-themes";
import { WorkspaceProvider } from "@/context/WorkspaceContext";

const ReactQueryDevtools = process.env.NODE_ENV === "development"
  ? dynamic(() => import("@tanstack/react-query-devtools").then((module) => module.ReactQueryDevtools), { ssr: false })
  : null;

function subscribeDesktopDevtools(listener: () => void) {
  const media = window.matchMedia("(min-width: 640px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const getDesktopDevtools = () => window.matchMedia("(min-width: 640px)").matches;

export default function Providers({ children }: { children: React.ReactNode }) {
  const desktopDevtools = useSyncExternalStore(subscribeDesktopDevtools, getDesktopDevtools, () => false);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </ThemeProvider>
          {desktopDevtools && ReactQueryDevtools && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
