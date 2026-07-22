import {
  formatMessage,
  localeNames,
  type Locale,
  type MessageKey,
} from "../../i18n/messages";

export const marketingPaths: Record<Locale, string> = {
  "zh-Hans": "/",
  ja: "/ja",
  en: "/en",
};

export const marketingLanguageLinks = (locale: Locale) => ([
  { locale: "zh-Hans" as const, href: marketingPaths["zh-Hans"], label: localeNames["zh-Hans"], current: locale === "zh-Hans" },
  { locale: "ja" as const, href: marketingPaths.ja, label: localeNames.ja, current: locale === "ja" },
  { locale: "en" as const, href: marketingPaths.en, label: localeNames.en, current: locale === "en" },
]);

export function marketingCopy(locale: Locale) {
  const t = (key: MessageKey) => formatMessage(locale, key);

  return {
    locale,
    currentLanguage: localeNames[locale],
    homePath: marketingPaths[locale],
    skip: t("marketing.skip"),
    nav: {
      primaryLabel: t("marketing.nav.primary"),
      brandHomeLabel: t("marketing.nav.brandHome"),
      web: t("marketing.nav.web"),
      download: t("marketing.nav.download"),
      languageLabel: t("marketing.nav.language"),
      menuOpenLabel: t("marketing.nav.open"),
      menuCloseLabel: t("marketing.nav.close"),
      items: [
        { href: "#before-you-go", label: t("marketing.nav.before") },
        { href: "#community", label: t("marketing.nav.community") },
        { href: "#host", label: t("marketing.nav.host") },
        { href: "#safety", label: t("marketing.nav.safety") },
      ],
      languages: marketingLanguageLinks(locale),
    },
    hero: {
      title: t("marketing.hero.title"),
      body: t("marketing.hero.body"),
      webCta: t("marketing.hero.webCta"),
      appStoreSoon: t("marketing.appStore.soon"),
      appStoreDownload: t("marketing.appStore.download"),
      appStorePreorder: t("marketing.appStore.preorder"),
    },
    before: {
      title: t("marketing.before.title"),
      body: t("marketing.before.body"),
      facts: [
        t("marketing.before.fact.time"),
        t("marketing.before.fact.area"),
        t("marketing.before.fact.fee"),
        t("marketing.before.fact.capacity"),
        t("marketing.before.fact.language"),
        t("marketing.before.fact.host"),
      ],
    },
    community: {
      title: t("marketing.community.title"),
      body: t("marketing.community.body"),
    },
    host: {
      title: t("marketing.host.title"),
      body: t("marketing.host.body"),
      steps: [
        t("marketing.host.step.create"),
        t("marketing.host.step.registration"),
        t("marketing.host.step.checkin"),
        t("marketing.host.step.notify"),
        t("marketing.host.step.review"),
      ],
    },
    cross: {
      title: t("marketing.cross.title"),
      body: t("marketing.cross.body"),
    },
    safety: {
      title: t("marketing.safety.title"),
      body: t("marketing.safety.body"),
      link: t("marketing.safety.link"),
      facts: [
        t("marketing.safety.fact.languages"),
        t("marketing.safety.fact.location"),
        t("marketing.safety.fact.fees"),
        t("marketing.safety.fact.attendance"),
        t("marketing.safety.fact.reporting"),
      ],
    },
    final: {
      title: t("marketing.final.title"),
      body: t("marketing.final.body"),
    },
    footer: {
      primaryLabel: t("marketing.footer.primary"),
      web: t("marketing.footer.web"),
      privacy: t("marketing.footer.privacy"),
      terms: t("marketing.footer.terms"),
      safety: t("marketing.footer.safety"),
      support: t("marketing.footer.support"),
      languagesLabel: t("marketing.footer.languages"),
    },
    assets: {
      hero: t("marketing.asset.hero"),
      detail: t("marketing.asset.detail"),
      community: t("marketing.asset.community"),
      hostWeb: t("marketing.asset.hostWeb"),
      crossApp: t("marketing.asset.crossApp"),
      crossWeb: t("marketing.asset.crossWeb"),
    },
  } as const;
}

export type MarketingCopy = ReturnType<typeof marketingCopy>;
