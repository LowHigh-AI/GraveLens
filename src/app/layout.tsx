import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "./sw-register";
import InstallPrompt from "@/components/InstallPrompt";
import AutoBackup from "@/components/sync/AutoBackup";
import { AuthProvider } from "@/lib/auth";
import { EcosystemProvider } from "@/components/ecosystem/EcosystemProvider";
import { LowHighSupportHost } from "@/components/ecosystem/lowhighShell";

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.gravelens.com"),
  // Single manifest source: the static public/manifest.json (also precached by
  // public/sw.js). src/app/manifest.ts was the conflicting dead duplicate.
  manifest: "/manifest.json",
  title: "GraveLens: Bring the story behind every stone into focus",
  description:
    "Photograph any headstone to travel through history and reveal a lifetime of memories. Discover the unique stories and legacies within every stone.",
  openGraph: {
    title: "GraveLens: Bring the story behind every stone into focus",
    description: "Photograph any headstone to travel through history and reveal a lifetime of memories.",
    url: "https://www.gravelens.com",
    siteName: "GraveLens",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "GraveLens Lifestyle Mockup",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GraveLens: Bring the story behind every stone into focus",
    description: "Photograph any headstone to travel through history and reveal a lifetime of memories.",
    images: ["/opengraph-image.png"],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "GraveLens",
  },
};


export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Allow pinch-to-zoom — improves accessibility for low-vision users.
  // iOS ignores userScalable:false anyway (removed in iOS 10).
  themeColor: "#1a1917",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable} overflow-hidden`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply stored settings before first paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem('gl_settings')||'{}');var scale={'small':'0.9','medium':'1','large':'1.1','xl':'1.2'}[s.fontSize||'medium']||'1';document.documentElement.style.setProperty('--font-scale',scale);var dark=s.theme==='dark'||(s.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches)||!s.theme;document.documentElement.setAttribute('data-theme',dark?'dark':'light');document.documentElement.setAttribute('data-high-contrast',s.highContrast?'true':'false');}catch(e){}})();`,
          }}
        />
      </head>
      <body className="flex flex-col h-full text-stone-50 font-sans overflow-hidden">
        <ServiceWorkerRegister />
        <AuthProvider>
          <EcosystemProvider>
            {children}
            <InstallPrompt />
            <AutoBackup />
            {/* Shared LowHigh support sheet: lives at the layout root so its
                fixed positioning is not trapped by transformed/filtered
                ancestors. Opened via openLowHighSupport(). */}
            <LowHighSupportHost />
          </EcosystemProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
