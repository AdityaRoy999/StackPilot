import type { Metadata } from "next";
import DashboardShell from "@/components/dashboard/DashboardShell";

export const metadata: Metadata = {
  title: "Dashboard | StackPilot Platform",
  description: "Manage your AI-Native deployments.",
  manifest: "/remote-manifest.webmanifest",
  icons: { icon: "/remote-icon-192.png", apple: "/remote-icon-180.png" },
  appleWebApp: { capable: true, title: "StackPilot", statusBarStyle: "black-translucent" },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
