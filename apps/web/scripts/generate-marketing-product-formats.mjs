import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const productRoot = path.resolve(scriptRoot, "../public/marketing/product");
const pngFiles = (await readdir(productRoot))
  .filter((file) => file.endsWith(".png"))
  .sort((left, right) => left.localeCompare(right));

if (pngFiles.length === 0) {
  throw new Error(`No PNG product assets found in ${productRoot}.`);
}

execFileSync("cwebp", ["-version"], { stdio: "ignore" });
execFileSync("sips", ["--formats"], { stdio: "ignore" });

for (const file of pngFiles) {
  const source = path.join(productRoot, file);
  const basename = file.slice(0, -4);
  const webp = path.join(productRoot, `${basename}.webp`);
  const avif = path.join(productRoot, `${basename}.avif`);
  const tempWebp = path.join(productRoot, `.${basename}.${process.pid}.webp`);
  const tempAvif = path.join(productRoot, `.${basename}.${process.pid}.avif`);

  try {
    execFileSync(
      "cwebp",
      ["-quiet", "-mt", "-q", "84", "-metadata", "none", source, "-o", tempWebp],
      { stdio: "inherit" },
    );
    execFileSync(
      "sips",
      ["-s", "format", "avif", "-s", "formatOptions", "80", source, "--out", tempAvif],
      { stdio: "ignore" },
    );
    await rename(tempWebp, webp);
    await rename(tempAvif, avif);
  } finally {
    await Promise.all([
      rm(tempWebp, { force: true }),
      rm(tempAvif, { force: true }),
    ]);
  }

  process.stdout.write([
    file,
    await digest(source),
    await digest(webp),
    await digest(avif),
  ].join("\t") + "\n");
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
