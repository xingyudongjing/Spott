import Link from "next/link";

import type { Locale } from "../../i18n/messages";
import type { LegalDocumentCopy } from "./legal-content";
import styles from "./LegalDocument.module.css";

export function LegalDocument({ document, locale }: { document: LegalDocumentCopy; locale: Locale }) {
  return (
    <main className={styles.page} id="legal-top" aria-labelledby="legal-title">
      <header className={styles.hero}>
        <p className={styles.eyebrow}>{document.eyebrow}</p>
        <h1 id="legal-title">{document.title}</h1>
        <p className={styles.introduction}>{document.introduction}</p>
        <p className={styles.effective}>
          <span>{document.effectiveLabel}</span>
          <time dateTime={document.effectiveDate}>{localizedDate(document.effectiveDate, locale)}</time>
        </p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.contents} aria-label={document.tableOfContents}>
          <p>{document.tableOfContents}</p>
          <ol>
            {document.sections.map((section, index) => (
              <li key={section.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <Link href={`#${section.id}`}>{section.title}</Link>
              </li>
            ))}
          </ol>
        </nav>

        <article className={styles.document}>
          {document.sections.map((section, index) => (
            <section id={section.id} key={section.id}>
              <p className={styles.sectionNumber}>{String(index + 1).padStart(2, "0")}</p>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.bullets ? (
                <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : null}
            </section>
          ))}

          <aside className={styles.related}>
            <span>{document.relatedLabel}</span>
            <Link href={document.relatedHref}>{document.relatedTitle}<DirectionIcon direction="right" /></Link>
          </aside>
          <Link className={styles.backToTop} href="#legal-top">{document.backToTop}<DirectionIcon direction="up" /></Link>
        </article>
      </div>
    </main>
  );
}

function DirectionIcon({ direction }: { direction: "right" | "up" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
      <path
        d={direction === "right" ? "M2.5 8h11M9.5 4l4 4-4 4" : "M8 13.5v-11M4 6.5l4-4 4 4"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function localizedDate(value: string, locale: Locale): string {
  const formatterLocale = locale === "zh-Hans" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en-US";
  return new Intl.DateTimeFormat(formatterLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}
