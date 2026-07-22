import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = path.join(webRoot, "public", "marketing", "product");
const manifestPath = path.join(productRoot, "manifest.json");

test("binds every marketing product image to a frozen, rights-safe capture record", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.source.treeState, "clean");
  assert.equal(manifest.capturePolicy, "real-rendered-product-surfaces-only");

  const pngFiles = (await readdir(productRoot))
    .filter((file) => file.endsWith(".png"))
    .sort();
  const recordedFiles = manifest.assets.map((asset) => asset.file).sort();
  assert.deepEqual(recordedFiles, pngFiles, "Every PNG, including non-marketing QA variants, needs provenance.");

  for (const asset of manifest.assets) {
    assert.match(asset.file, /^[A-Za-z0-9-]+\.png$/u);
    assert.ok(["zh-Hans", "ja", "en"].includes(asset.locale));
    assert.ok(["web", "ios"].includes(asset.platform));
    assert.equal(asset.fixture.kind, "original-synthetic");
    assert.ok(asset.fixture.id.length >= 8);
    assert.ok(asset.surface.length >= 3);
    assert.ok(asset.uiState.length >= 3);
    assert.ok(asset.captureCommand.length >= 8);
    assert.equal(asset.crop, "none");
    assert.equal(asset.redaction, "not-required-synthetic-data");
    assert.equal(asset.rights, "spott-original-product-evidence");
    assert.ok(["light", "dark"].includes(asset.appearance));
    assert.match(asset.capturedAt, /^2026-07-22T/u);
    assert.ok(Number.isInteger(asset.viewport.width) && asset.viewport.width > 0);
    assert.ok(Number.isInteger(asset.viewport.height) && asset.viewport.height > 0);
    assert.ok(asset.textScale.length >= 3);

    const pngPath = path.join(productRoot, asset.file);
    const png = await readFile(pngPath);
    const dimensions = pngDimensions(png);
    assert.deepEqual(dimensions, asset.viewport, `${asset.file} viewport differs from its PNG.`);
    await assertFormat(asset, "png", pngPath);
    await assertFormat(asset, "webp", pngPath.replace(/\.png$/u, ".webp"));
    await assertFormat(asset, "avif", pngPath.replace(/\.png$/u, ".avif"));
  }
});

async function assertFormat(asset, format, file) {
  const bytes = await readFile(file);
  const fileStat = await stat(file);
  assert.equal(asset.formats[format].bytes, fileStat.size, `${asset.file} ${format} byte count drifted.`);
  assert.equal(
    asset.formats[format].sha256,
    createHash("sha256").update(bytes).digest("hex"),
    `${asset.file} ${format} hash drifted.`,
  );
}

function pngDimensions(buffer) {
  const signature = "89504e470d0a1a0a";
  assert.equal(buffer.subarray(0, 8).toString("hex"), signature, "Expected a PNG signature.");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", "Expected PNG IHDR first.");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
