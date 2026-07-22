import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { SiteHeader } from "./components/SiteHeader";
import { AppDialogProvider } from "./components/AppDialog";
import { I18nProvider } from "./components/I18nProvider";
import { ServiceWorkerRegistrar } from "./components/ServiceWorkerRegistrar";
import { SyncEngineRegistrar } from "./components/SyncEngineRegistrar";
import { SessionProvider } from "./components/SessionProvider";
import { PreviewModeProvider } from "./components/PreviewModeProvider";
import { formatMessage, type Locale } from "./i18n/messages";
import { serverLocale } from "./i18n/server";
import { parsePreviewMode } from "./lib/preview-mode";
import { routeShellFromHeader, routeShellRequestHeader } from "./lib/route-shell";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

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
    manifest: `/manifest/${locale}.webmanifest`,
    openGraph: {
      title,
      description,
      siteName: "Spott",
      locale: openGraphLocales[locale],
      type: "website",
      images: [{ url: "/og.jpg", width: 1536, height: 1024, alt: title, type: "image/jpeg" }],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/og.jpg"] },
    icons: { icon: "/favicon.svg", apple: "/spott-icon.svg" },
  };
}

export const viewport: Viewport = {
  themeColor: "#F7F5F0",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [locale, requestHeaders] = await Promise.all([serverLocale(), headers()]);
  const routeShell = routeShellFromHeader(requestHeaders.get(routeShellRequestHeader));
  if (routeShell === "marketing") {
    return (
      <html lang={locale} data-scroll-behavior="smooth">
        <body className={inter.variable} data-route-shell="marketing">
          {children}
        </body>
      </html>
    );
  }

  const previewMode = parsePreviewMode(requestHeaders.get("x-spott-preview-mode"));
  return (
    <html lang={locale} data-scroll-behavior="smooth">
      <body className={inter.variable} data-route-shell="product">
        <I18nProvider initialLocale={locale}>
          <PreviewModeProvider initialMode={previewMode}>
            <AppDialogProvider>
              <SessionProvider>
                <a className="skip-link" href="#spott-main-content">
                  {formatMessage(locale, "common.skipToContent")}
                </a>
                <SiteHeader />
                <div id="spott-main-content" tabIndex={-1}>{children}</div>
                <ServiceWorkerRegistrar />
                <SyncEngineRegistrar />
              </SessionProvider>
            </AppDialogProvider>
          </PreviewModeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
