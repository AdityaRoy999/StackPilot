import type { Metadata } from "next";
import DashboardShell from "@/components/dashboard/DashboardShell";

export const metadata: Metadata = {
  title: "Dashboard | AIDS Platform",
  description: "Manage your AI-Native deployments.",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
