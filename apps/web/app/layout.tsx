import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_JP, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "./components/SiteHeader";
import { AppDialogProvider } from "./components/AppDialog";
import { I18nProvider } from "./components/I18nProvider";
import { ServiceWorkerRegistrar } from "./components/ServiceWorkerRegistrar";
import { formatMessage, type Locale } from "./i18n/messages";
import { serverLocale } from "./i18n/server";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const notoSC = Noto_Sans_SC({ variable: "--font-noto-sc", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const notoJP = Noto_Sans_JP({ variable: "--font-noto-jp", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

const openGraphLocales: Record<Locale, string> = {
  "zh-Hans": "zh_CN",
  ja: "ja_JP",
  en: "en_US",
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await serverLocale();
  const title = formatMessage(locale, "metadata.title");
  const description = formatMessage(locale, "metadata.description");
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://spott.jp"),
    title: { default: title, template: "%s · Spott" },
    description,
    applicationName: "Spott",
    manifest: "/manifest.webmanifest",
    openGraph: {
      title,
      description,
      siteName: "Spott",
      locale: openGraphLocales[locale],
      type: "website",
      images: [{ url: "/og.png", width: 1536, height: 1024, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
    robots: { index: true, follow: true },
    icons: { icon: "/favicon.svg", apple: "/spott-icon.svg" },
  };
}

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
