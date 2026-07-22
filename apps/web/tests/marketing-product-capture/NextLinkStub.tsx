import type { AnchorHTMLAttributes } from "react";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  prefetch?: boolean;
};

export default function NextLinkStub({ href, prefetch: _prefetch, ...props }: LinkProps) {
  void _prefetch;
  return <a {...props} href={href} />;
}
