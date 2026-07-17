import type { Locale } from "./messages";

export function localeFromAcceptLanguage(value: string | null): Locale | null {
  if (!value) return null;
  const candidates = value
    .split(",")
    .map((entry, index) => {
      const [rawLanguage, ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const parsedQuality = qualityParameter
        ? Number.parseFloat(qualityParameter.trim().slice(2))
        : 1;
      return {
        language: rawLanguage?.toLowerCase() ?? "",
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
        index,
      };
    })
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const candidate of candidates) {
    if (candidate.language === "ja" || candidate.language.startsWith("ja-")) return "ja";
    if (candidate.language === "en" || candidate.language.startsWith("en-")) return "en";
    if (candidate.language === "zh" || candidate.language.startsWith("zh-")) return "zh-Hans";
  }
  return null;
}
