import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";
import Providers from "@/lib/providers";
import { UI_THEME_INIT_SCRIPT, ICON_INIT_SCRIPT } from "@/lib/theme-init";
import { Toaster } from "@/components/ui/sonner";

const plusJakartaSans = localFont({
  src: "./fonts/PlusJakartaSans-Variable.ttf",
  weight: "200 800",
  variable: "--font-plus-jakarta",
  display: "swap",
});

const jetBrainsMono = localFont({
  src: "./fonts/JetBrainsMono-Variable.ttf",
  weight: "100 800",
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "StackPilot | AI Application Delivery Cockpit",
  description: "AI-assisted application delivery cockpit for Docker, Kubernetes, source projects, and ready-to-run application templates.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plusJakartaSans.variable} ${jetBrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Script
          id="stackpilot-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `${UI_THEME_INIT_SCRIPT}\n${ICON_INIT_SCRIPT}`,
          }}
        />
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
