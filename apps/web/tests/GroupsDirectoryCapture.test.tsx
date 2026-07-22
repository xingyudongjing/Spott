import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../app/components/I18nProvider";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { GroupsDirectory } from "../app/groups/GroupsDirectory";
import { apiRequest, type GroupView } from "../app/lib/client-api";

vi.mock("../app/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/client-api")>()),
  apiRequest: vi.fn(),
}));

const frozenGroup: GroupView = {
  availableActions: ["request_join"],
  capacity: 40,
  categoryId: "city-walk",
  description: "A frozen public community used for product-evidence capture.",
  id: "019b0000-0000-7000-8200-000000000001",
  joinMode: "approval",
  memberCount: 18,
  name: "Tokyo Slow Walks",
  regionId: "tokyo",
  slug: "tokyo-slow-walks",
  status: "active",
  tags: ["city-walk", "photography"],
  version: 3,
};

describe("groups-directory marketing capture seam", () => {
  test("renders frozen public groups without requesting live group data", () => {
    render(
      <I18nProvider initialLocale="en">
        <PreviewModeProvider initialMode="read-only">
          <GroupsDirectory initialItems={[frozenGroup]} />
        </PreviewModeProvider>
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: frozenGroup.name })).toBeInTheDocument();
    expect(vi.mocked(apiRequest)).not.toHaveBeenCalled();
  });
});
