import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptRoot, "..");
const repositoryRoot = path.resolve(webRoot, "../..");
const productRoot = path.join(webRoot, "public", "marketing", "product");
const manifestPath = path.join(productRoot, "manifest.json");
const sourceCommit = resolveSourceCommit();

assertCommit(sourceCommit);

const pngFiles = (await readdir(productRoot))
  .filter((file) => file.endsWith(".png"))
  .sort((left, right) => left.localeCompare(right));

if (pngFiles.length === 0) {
  throw new Error(`No PNG product assets found in ${productRoot}.`);
}

const assets = [];
for (const file of pngFiles) {
  const pngPath = path.join(productRoot, file);
  const png = await readFile(pngPath);
  assertFrozenPng(file, png);
  assets.push({
    ...captureMetadata(file),
    file,
    capturedAt: await capturedAt(pngPath),
    viewport: pngDimensions(png),
    formats: {
      png: await formatMetadata(pngPath),
      webp: await formatMetadata(pngPath.replace(/\.png$/u, ".webp")),
      avif: await formatMetadata(pngPath.replace(/\.png$/u, ".avif")),
    },
  });
}

const manifest = {
  schemaVersion: 2,
  source: {
    commit: sourceCommit,
    treeState: "clean",
  },
  capturePolicy: "real-rendered-product-surfaces-only",
  assets,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${assets.length} frozen capture records to ${manifestPath}\n`);

function resolveSourceCommit() {
  const explicit = process.env.SPOTT_MARKETING_SOURCE_COMMIT?.trim();
  if (explicit) return explicit;
  return git(["rev-parse", "HEAD"]);
}

function assertCommit(commit) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`Expected a full 40-character source commit, received ${JSON.stringify(commit)}.`);
  }
  const objectType = git(["cat-file", "-t", commit]);
  if (objectType !== "commit") {
    throw new Error(`${commit} is a ${objectType}, not a commit.`);
  }
}

function assertFrozenPng(file, workingBytes) {
  const repositoryPath = path.posix.join("apps/web/public/marketing/product", file);
  let frozenBytes;
  try {
    frozenBytes = execFileSync("git", ["show", `${sourceCommit}:${repositoryPath}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${file} is not present in frozen source commit ${sourceCommit}.`);
  }
  if (digest(frozenBytes) !== digest(workingBytes)) {
    throw new Error(`${file} differs from frozen source commit ${sourceCommit}; recapture or freeze it first.`);
  }
}

function captureMetadata(file) {
  const webMatch = /^web-(discover|event-detail|groups|host)-(zh-Hans|ja|en)-(desktop|mobile)\.png$/u.exec(file);
  if (webMatch) {
    const [, surfaceKey, locale] = webMatch;
    const details = {
      discover: {
        fixtureId: "marketing-discovery-20260722",
        surface: "event-discovery",
        uiState: "localized-upcoming-event-results",
      },
      "event-detail": {
        fixtureId: "marketing-event-detail-20260722",
        surface: "public-event-detail",
        uiState: "localized-published-event",
      },
      groups: {
        fixtureId: "marketing-groups-20260722",
        surface: "public-community-directory",
        uiState: "localized-community-results",
      },
      host: {
        fixtureId: "marketing-host-studio-20260722",
        surface: "host-event-studio",
        uiState: "localized-published-and-draft-events",
      },
    }[surfaceKey];
    return commonMetadata({
      appearance: "light",
      captureCommand: surfaceKey === "host"
        ? "node apps/web/scripts/capture-host-studio.mjs"
        : "node apps/web/scripts/capture-marketing-products.mjs",
      fixtureId: details.fixtureId,
      locale,
      platform: "web",
      surface: details.surface,
      textScale: "browser-default-100-percent",
      uiState: details.uiState,
    });
  }

  const iosMatch = /^ios-community-(zh-Hans|ja|en)-(light|dark|ax5)\.png$/u.exec(file);
  if (iosMatch) {
    const [, locale, variant] = iosMatch;
    const language = { "zh-Hans": "Chinese", ja: "Japanese", en: "English" }[locale];
    const size = variant === "ax5" ? "MaximumAccessibility" : "Standard";
    const testName = `test${language}${size}CommunityUIAndLocalizedDemoFixture`;
    const testCommand = `xcodebuild test -only-testing:SpottUITests/GroupCommunityAccessibilityUITests/${testName}`;
    return commonMetadata({
      appearance: variant === "dark" ? "dark" : "light",
      captureCommand: variant === "dark"
        ? `xcrun simctl ui booted appearance dark && ${testCommand}`
        : testCommand,
      fixtureId: "ios-community-demo-20260722",
      locale,
      platform: "ios",
      surface: "community-directory",
      textScale: variant === "ax5" ? "accessibility-xxxl" : "standard",
      uiState: variant === "ax5"
        ? "localized-signed-out-directory-accessibility-xxxl"
        : "localized-signed-out-directory",
    });
  }

  throw new Error(`No provenance metadata mapping exists for ${file}.`);
}

function commonMetadata({
  appearance,
  captureCommand,
  fixtureId,
  locale,
  platform,
  surface,
  textScale,
  uiState,
}) {
  return {
    locale,
    platform,
    surface,
    uiState,
    fixture: {
      kind: "original-synthetic",
      id: fixtureId,
    },
    captureCommand,
    crop: "none",
    redaction: "not-required-synthetic-data",
    rights: "spott-original-product-evidence",
    appearance,
    textScale,
  };
}

async function capturedAt(file) {
  const fileStat = await stat(file);
  const iso = fileStat.mtime.toISOString();
  if (!iso.startsWith("2026-07-22T")) {
    throw new Error(`${path.basename(file)} has unexpected capture timestamp ${iso}.`);
  }
  return iso;
}

async function formatMetadata(file) {
  const bytes = await readFile(file);
  return {
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  };
}

function pngDimensions(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Expected a PNG signature.");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Expected PNG IHDR first.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}
