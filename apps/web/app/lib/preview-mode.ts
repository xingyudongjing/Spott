export type PreviewMode = "standard" | "read-only" | "internal-test";

export function parsePreviewMode(value: string | null | undefined): PreviewMode {
  return value === "read-only" || value === "internal-test" ? value : "standard";
}
