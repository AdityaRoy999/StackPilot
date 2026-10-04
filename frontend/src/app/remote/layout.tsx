import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "StackPilot Remote", manifest: "/remote-manifest.webmanifest",
  icons: { icon: "/remote-icon-192.png", apple: "/remote-icon-180.png" },
  appleWebApp: { capable: true, title: "StackPilot Remote", statusBarStyle: "black-translucent" },
};
export default function RemoteLayout({ children }: { children: React.ReactNode }) { return children; }
