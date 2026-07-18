"use client";

import NextLink from "next/link";
import type { AnchorHTMLAttributes } from "react";

import { usePreviewMode } from "./PreviewModeProvider";

type PreviewModeLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  prefetch?: boolean;
};

export function PreviewModeLink({ href, prefetch, ...props }: PreviewModeLinkProps) {
  if (usePreviewMode() === "read-only") {
    return <a {...props} href={href} />;
  }

  return <NextLink {...props} href={href} prefetch={prefetch} />;
}
