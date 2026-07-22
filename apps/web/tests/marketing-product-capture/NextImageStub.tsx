/* eslint-disable @next/next/no-img-element */
import type { ImgHTMLAttributes } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt"> & {
  alt: string;
  fill?: boolean;
  priority?: boolean;
};

export default function NextImageStub({ alt, fill, priority: _priority, style, ...props }: ImageProps) {
  void _priority;
  return (
    <img
      alt={alt}
      {...props}
      style={fill ? { ...style, height: "100%", inset: 0, objectFit: "cover", position: "absolute", width: "100%" } : style}
    />
  );
}
