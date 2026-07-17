"use client";

const copy = {
  "zh-Hans": ["暂时中断", "页面没有顺利加载", "请重新加载页面；若问题仍然存在，请稍后再试。", "重新加载"],
  ja: ["一時的な中断", "ページを読み込めませんでした", "ページを再読み込みしてください。問題が続く場合は少し時間をおいてください。", "再読み込み"],
  en: ["Temporary interruption", "This page did not load", "Reload the page. If the problem continues, please try again shortly.", "Reload"],
} as const;

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const language = typeof navigator === "undefined" ? "zh-Hans" : navigator.language;
  const locale = language.toLowerCase().startsWith("ja")
    ? "ja"
    : language.toLowerCase().startsWith("en") ? "en" : "zh-Hans";
  const [eyebrow, title, body, action] = copy[locale];
  return (
    <html lang={locale}>
      <body>
        <main className="system-fallback" role="alert">
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{body}</p>
          <div><button type="button" onClick={reset}>{action}</button></div>
        </main>
      </body>
    </html>
  );
}
