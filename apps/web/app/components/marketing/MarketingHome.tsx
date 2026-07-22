import { appStoreAvailability } from "../../lib/app-store";
import { AppStoreDownload } from "./AppStoreDownload";
import { MarketingFooter } from "./MarketingFooter";
import { MarketingHeader } from "./MarketingHeader";
import { marketingStructuredData } from "./MarketingMetadata";
import { ProductStage } from "./ProductStage";
import { ProductStorySection } from "./ProductStorySection";
import { marketingCopy } from "./marketing-copy";
import type { Locale } from "../../i18n/messages";
import styles from "./marketing-home.module.css";

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}

function FinalRouteLines() {
  return (
    <svg aria-hidden="true" className={styles.finalRouteLines} viewBox="0 0 900 520">
      <path d="M-20 138h220l54 54h120l74 74h166l68 68h238" />
      <path d="M42 72h220l54 54h132l78 78h180l78 78h156" />
      <path d="M646-20v112l56 56v110l68 68v214" />
      <circle cx="254" cy="192" r="5" />
      <circle cx="702" cy="148" r="5" />
      <circle className={styles.finalRouteAccent} cx="770" cy="326" r="7" />
    </svg>
  );
}

export function MarketingHome({ locale }: { readonly locale: Locale }) {
  const copy = marketingCopy(locale);
  const availability = appStoreAvailability();
  const structuredData = marketingStructuredData(locale);

  return (
    <div className={styles.marketingRoot} data-locale={locale}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
      <a className={styles.skipLink} href="#spott-marketing-main">{copy.skip}</a>
      <MarketingHeader availability={availability} copy={copy} />

      <main id="spott-marketing-main" tabIndex={-1}>
        <section aria-labelledby="marketing-hero-title" className={styles.heroSection}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <h1 className={styles.heroTitle} id="marketing-hero-title">{copy.hero.title}</h1>
              <p className={styles.heroBody}>{copy.hero.body}</p>
              <AppStoreDownload availability={availability} copy={copy} placement="hero" />
            </div>
            <div className={styles.heroVisual} id="discover">
              <ProductStage labels={[copy.assets.hero]} locale={locale} variant="hero" />
            </div>
          </div>
          <span aria-hidden="true" className={styles.heroSectionEdge} />
        </section>

        <section
          aria-labelledby="before-you-go-heading"
          className={styles.beforeSection}
          id="before-you-go"
        >
          <div className={styles.beforeInner}>
            <div className={styles.beforeCopy}>
              <h2 className={styles.sectionTitle} id="before-you-go-heading">{copy.before.title}</h2>
              <p className={styles.sectionBody}>{copy.before.body}</p>
              <ul className={styles.factRail}>
                {copy.before.facts.map((fact, index) => (
                  <li key={fact}>
                    <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <strong>{fact}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.beforeVisual}>
              <ProductStage labels={[copy.assets.detail]} locale={locale} variant="detail" />
            </div>
          </div>
        </section>

        <ProductStorySection
          body={copy.community.body}
          id="community"
          title={copy.community.title}
          variant="community"
        >
          <ProductStage labels={[copy.assets.community]} locale={locale} variant="community" />
        </ProductStorySection>

        <section aria-labelledby="host-heading" className={styles.hostSection} id="host">
          <div className={styles.hostInner}>
            <div className={styles.hostCopy}>
              <h2 className={styles.sectionTitle} id="host-heading">{copy.host.title}</h2>
              <p className={styles.sectionBody}>{copy.host.body}</p>
              <ol className={styles.workflowRail}>
                {copy.host.steps.map((step, index) => (
                  <li key={step}>
                    <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <strong>{step}</strong>
                  </li>
                ))}
              </ol>
            </div>
            <div className={styles.hostVisual}>
              <ProductStage labels={[copy.assets.hostWeb]} locale={locale} variant="host" />
            </div>
          </div>
        </section>

        <ProductStorySection
          body={copy.cross.body}
          id="cross-surface"
          title={copy.cross.title}
          variant="cross"
        >
          <ProductStage labels={[copy.assets.crossWeb, copy.assets.crossApp]} locale={locale} variant="cross" />
        </ProductStorySection>

        <section aria-labelledby="safety-heading" className={styles.safetySection} id="safety">
          <div className={styles.safetyInner}>
            <div className={styles.safetyCopy}>
              <h2 className={styles.sectionTitle} id="safety-heading">{copy.safety.title}</h2>
              <p className={styles.sectionBody}>{copy.safety.body}</p>
              <a className={styles.safetyLink} href="/safety">
                <span>{copy.safety.link}</span>
                <ArrowIcon />
              </a>
            </div>
            <ul className={styles.safetyFacts}>
              {copy.safety.facts.map((fact) => <li key={fact}>{fact}</li>)}
            </ul>
          </div>
        </section>

        <section aria-labelledby="final-download-heading" className={styles.finalSection}>
          <FinalRouteLines />
          <div className={styles.finalInner}>
            <h2 className={styles.sectionTitle} id="final-download-heading">{copy.final.title}</h2>
            <p className={styles.sectionBody}>{copy.final.body}</p>
            <AppStoreDownload availability={availability} copy={copy} placement="final" />
            {availability.state === "available" ? null : (
              <p className={styles.finalStoreStatus}>{copy.hero.appStoreSoon}</p>
            )}
          </div>
        </section>
      </main>

      <MarketingFooter
        copy={copy}
        showAppleTrademarkCredit={availability.state === "available"}
      />
    </div>
  );
}
