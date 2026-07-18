import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { EventCover } from "../app/components/EventCover";

describe("event cover fallback art", () => {
  test.each([
    ["city-walk", "city-walk"],
    ["music", "music"],
    ["outdoor", "outdoor"],
  ])("uses a category-specific illustration for %s", (category, illustration) => {
    render(<EventCover event={{ title: `${category} event`, category }} />);

    expect(screen.getByRole("img", { name: `${category} event` })).toHaveAttribute(
      "data-illustration",
      illustration,
    );
  });
});
