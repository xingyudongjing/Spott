import styles from "./marketing-home.module.css";
import type { Locale } from "../../i18n/messages";

type ProductStageProps = {
  readonly labels: readonly [string] | readonly [string, string];
  readonly locale: Locale;
  readonly variant: "hero" | "detail" | "community" | "host" | "cross";
};

type ProductAsset = {
  readonly height: number;
  readonly mobileHeight?: number;
  readonly mobileSrc?: string;
  readonly mobileWidth?: number;
  readonly priority?: boolean;
  readonly sizes: string;
  readonly src: string;
  readonly width: number;
};

const assetVersion = "20260722-2";
const discoverDesktop: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-discover-zh-Hans-desktop.png?v=${assetVersion}`,
  ja: `/marketing/product/web-discover-ja-desktop.png?v=${assetVersion}`,
  en: `/marketing/product/web-discover-en-desktop.png?v=${assetVersion}`,
};
const discoverMobile: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-discover-zh-Hans-mobile.png?v=${assetVersion}`,
  ja: `/marketing/product/web-discover-ja-mobile.png?v=${assetVersion}`,
  en: `/marketing/product/web-discover-en-mobile.png?v=${assetVersion}`,
};
const detailDesktop: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-event-detail-zh-Hans-desktop.png?v=${assetVersion}`,
  ja: `/marketing/product/web-event-detail-ja-desktop.png?v=${assetVersion}`,
  en: `/marketing/product/web-event-detail-en-desktop.png?v=${assetVersion}`,
};
const groupsDesktop: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-groups-zh-Hans-desktop.png?v=${assetVersion}`,
  ja: `/marketing/product/web-groups-ja-desktop.png?v=${assetVersion}`,
  en: `/marketing/product/web-groups-en-desktop.png?v=${assetVersion}`,
};
const groupsMobile: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-groups-zh-Hans-mobile.png?v=${assetVersion}`,
  ja: `/marketing/product/web-groups-ja-mobile.png?v=${assetVersion}`,
  en: `/marketing/product/web-groups-en-mobile.png?v=${assetVersion}`,
};
const iosCommunityLight: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/ios-community-zh-Hans-light.png?v=${assetVersion}`,
  ja: `/marketing/product/ios-community-ja-light.png?v=${assetVersion}`,
  en: `/marketing/product/ios-community-en-light.png?v=${assetVersion}`,
};
const hostDesktop: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-host-zh-Hans-desktop.png?v=${assetVersion}`,
  ja: `/marketing/product/web-host-ja-desktop.png?v=${assetVersion}`,
  en: `/marketing/product/web-host-en-desktop.png?v=${assetVersion}`,
};
const detailMobile: Record<Locale, string> = {
  "zh-Hans": `/marketing/product/web-event-detail-zh-Hans-mobile.png?v=${assetVersion}`,
  ja: `/marketing/product/web-event-detail-ja-mobile.png?v=${assetVersion}`,
  en: `/marketing/product/web-event-detail-en-mobile.png?v=${assetVersion}`,
};
function RouteLines() {
  return (
    <svg aria-hidden="true" className={styles.stageRouteLines} viewBox="0 0 800 620">
      <path d="M-40 478h176l58-58h118l78-78h144l64-64h232" />
      <path d="M-28 520h228l44-44h136l92-92h120l86-86h160" />
      <path d="M486-20v112l54 54v106l66 66v130l58 58v134" />
      <circle cx="194" cy="420" r="5" />
      <circle cx="540" cy="146" r="5" />
      <circle className={styles.routeAccent} cx="606" cy="318" r="7" />
    </svg>
  );
}

function NeutralAsset({
  className,
  image,
  label,
  slot,
}: {
  readonly className: string;
  readonly image: ProductAsset;
  readonly label: string;
  readonly slot: string;
}) {
  const desktopAvif = productAssetFormat(image.src, "avif");
  const desktopWebp = productAssetFormat(image.src, "webp");
  const mobileAvif = image.mobileSrc ? productAssetFormat(image.mobileSrc, "avif") : null;
  const mobileWebp = image.mobileSrc ? productAssetFormat(image.mobileSrc, "webp") : null;

  return (
    <div
      className={`${className} ${styles.realAssetCanvas}`}
      data-product-asset-slot={slot}
    >
      <picture className={styles.assetPicture}>
        {mobileAvif ? (
          <source
            height={image.mobileHeight}
            media="(max-width: 640px)"
            srcSet={mobileAvif}
            type="image/avif"
            width={image.mobileWidth}
          />
        ) : null}
        {mobileWebp ? (
          <source
            height={image.mobileHeight}
            media="(max-width: 640px)"
            srcSet={mobileWebp}
            type="image/webp"
            width={image.mobileWidth}
          />
        ) : null}
        {image.mobileSrc ? (
          <source
            height={image.mobileHeight}
            media="(max-width: 640px)"
            srcSet={image.mobileSrc}
            width={image.mobileWidth}
          />
        ) : null}
        <source srcSet={desktopAvif} type="image/avif" />
        <source srcSet={desktopWebp} type="image/webp" />
        <img
          alt={label}
          decoding="async"
          fetchPriority={image.priority ? "high" : "auto"}
          height={image.height}
          loading={image.priority ? "eager" : "lazy"}
          sizes={image.sizes}
          src={image.src}
          width={image.width}
        />
      </picture>
    </div>
  );
}

function productAssetFormat(source: string, format: "avif" | "webp"): string {
  const queryIndex = source.indexOf("?");
  const pathname = queryIndex === -1 ? source : source.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : source.slice(queryIndex);
  if (!pathname.endsWith(".png")) {
    throw new Error(`Marketing product asset must use a PNG fallback: ${source}`);
  }
  return `${pathname.slice(0, -4)}.${format}${query}`;
}

export function ProductStage({ labels, locale, variant }: ProductStageProps) {
  if (variant === "hero") {
    return (
      <figure className={`${styles.productStage} ${styles.heroProductStage}`}>
        <RouteLines />
        <NeutralAsset
          className={`${styles.assetCanvas} ${styles.heroRearCanvas}`}
          image={{
            height: 900,
            priority: true,
            sizes: "(max-width: 900px) 72vw, 36vw",
            src: discoverDesktop[locale],
            width: 1440,
          }}
          label=""
          slot="hero-discovery-web"
        />
        <NeutralAsset
          className={`${styles.assetCanvas} ${styles.heroMainCanvas}`}
          image={{
            height: 844,
            priority: true,
            sizes: "(max-width: 640px) 76vw, (max-width: 900px) 58vw, 28vw",
            src: discoverMobile[locale],
            width: 390,
          }}
          label={labels[0]}
          slot="hero-discovery-mobile"
        />
      </figure>
    );
  }

  if (variant === "detail") {
    return (
      <figure className={`${styles.productStage} ${styles.detailProductStage}`}>
        <RouteLines />
        <NeutralAsset
          className={`${styles.assetCanvas} ${styles.detailCanvas}`}
          image={{
            height: 900,
            mobileSrc: detailMobile[locale],
            sizes: "(max-width: 900px) 94vw, 52vw",
            src: detailDesktop[locale],
            width: 1440,
          }}
          label={labels[0]}
          slot="before-you-go-detail"
        />
      </figure>
    );
  }

  if (variant === "community") {
    return (
      <figure className={`${styles.productStage} ${styles.communityProductStage}`}>
        <RouteLines />
        <NeutralAsset
          className={`${styles.assetCanvas} ${styles.communityCanvas}`}
          image={{
            height: 2622,
            sizes: "(max-width: 640px) 86vw, 32vw",
            src: iosCommunityLight[locale],
            width: 1206,
          }}
          label={labels[0]}
          slot="community"
        />
      </figure>
    );
  }

  if (variant === "host") {
    return (
      <figure className={`${styles.productStage} ${styles.hostProductStage}`}>
        <RouteLines />
        <NeutralAsset
          className={`${styles.assetCanvas} ${styles.hostCanvas}`}
          image={{
            height: 900,
            sizes: "(max-width: 900px) 94vw, 52vw",
            src: hostDesktop[locale],
            width: 1440,
          }}
          label={labels[0]}
          slot="host-web"
        />
      </figure>
    );
  }

  return (
    <figure className={`${styles.productStage} ${styles.crossProductStage}`}>
      <RouteLines />
      <NeutralAsset
        className={`${styles.assetCanvas} ${styles.pairedWideCanvas}`}
        image={{
          height: 900,
          mobileHeight: 844,
          mobileSrc: groupsMobile[locale],
          mobileWidth: 390,
          sizes: "(max-width: 900px) 84vw, 48vw",
          src: groupsDesktop[locale],
          width: 1440,
        }}
        label={labels[0]}
        slot="cross-web"
      />
      <NeutralAsset
        className={`${styles.assetCanvas} ${styles.pairedTallCanvas}`}
        image={{
          height: 2622,
          sizes: "(max-width: 900px) 42vw, 22vw",
          src: iosCommunityLight[locale],
          width: 1206,
        }}
        label={labels[1] ?? labels[0]}
        slot="cross-app"
      />
    </figure>
  );
}
