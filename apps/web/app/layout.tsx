import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_JP, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "./components/SiteHeader";
import { AppDialogProvider } from "./components/AppDialog";
import { I18nProvider } from "./components/I18nProvider";
import { ServiceWorkerRegistrar } from "./components/ServiceWorkerRegistrar";
import { serverLocale } from "./i18n/server";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const notoSC = Noto_Sans_SC({ variable: "--font-noto-sc", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const notoJP = Noto_Sans_JP({ variable: "--font-noto-jp", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://spott.jp"),
  title: { default: "Spott · 发现活动，遇见同好", template: "%s · Spott" },
  description: "发现东京与日本各地真实、有趣、认真组织的同城活动。",
  applicationName: "Spott",
  manifest: "/manifest.webmanifest",
  openGraph: {
    siteName: "Spott",
    locale: "zh_CN",
    type: "website",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Spott · 发现活动，遇见同好" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.svg", apple: "/spott-icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F5F0" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1014" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await serverLocale();
  return (
    <html lang={locale} data-scroll-behavior="smooth">
      <body className={`${inter.variable} ${notoSC.variable} ${notoJP.variable}`}>
        <I18nProvider initialLocale={locale}>
          <AppDialogProvider>
            <SiteHeader />
            {children}
            <ServiceWorkerRegistrar />
          </AppDialogProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
