import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { EventComposer } from "../app/create/EventComposer";
import { composerDraftStorageKey } from "../app/create/event-composer-draft";
import { apiRequest, readSession, type WebSession } from "../app/lib/client-api";
import type { EventView } from "../app/lib/demo-data";
import { eventFixture, makeDetail, renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn(), readSession: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);
const eventId = eventFixture.id;

const session: WebSession = {
  accessToken: "host-access-token",
  accessTokenExpiresAt: "2026-07-25T00:00:00.000Z",
  refreshToken: "host-refresh-token",
  sessionId: "019b0000-0000-7000-8100-0000000000c1",
  user: {
    id: eventFixture.organizerId,
    publicHandle: "weekend_kai",
    phoneVerified: true,
    restrictions: [],
  },
};

function hostedEvent(overrides: Partial<EventView> = {}): EventView {
  return {
    ...makeDetail({
      description:
        "沿着隅田川的河岸慢慢走一段，从清澄白河站出发，经过几座老桥与河边的小公园，最后在河口一起看日落，全程大约三公里，走走停停两个半小时。",
      media: [
        {
          id: "019b0000-0000-7000-8100-0000000000f1",
          assetId: "019b0000-0000-7000-8100-0000000000f2",
          sortOrder: 0,
          state: "ready",
          moderationState: "approved",
        },
      ],
      mediaCount: 1,
    }),
    categoryLabel: "城市探索",
    priceLabel: "免费",
    organizer: { ...eventFixture.organizer, reliability: "high" },
    availableActions: ["edit", "cancelEvent"],
    ...overrides,
  } as unknown as EventView;
}

beforeEach(() => {
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(session);
  window.localStorage.clear();
});

describe("studio event editor", () => {
  test("hydrates from the server and saves with the cloud version as If-Match", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}` && !init?.method) return hostedEvent();
      if (path === "/me/groups") return { items: [] };
      if (path === `/events/${eventId}` && init?.method === "PATCH") {
        return {
          id: eventId,
          publicSlug: eventFixture.publicSlug,
          version: 3,
          status: "published",
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <EventComposer editEventId={eventId} />
      </AppDialogProvider>,
    );

    const title = await screen.findByLabelText(/活动标题/);
    expect(title).toHaveValue(eventFixture.title);
    expect(screen.getByText(/这场活动已公开/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存并继续 →" }));

    await waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, init]) => path === `/events/${eventId}` && init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patch = apiRequestMock.mock.calls.find(
      ([path, init]) => path === `/events/${eventId}` && init?.method === "PATCH",
    );
    expect(patch?.[1]?.ifMatch).toBe(eventFixture.version);
    expect(patch?.[1]?.idempotent).toBe(true);
    expect(window.localStorage.getItem(composerDraftStorageKey(session.user.id))).toBeNull();
  });

  test("refuses to edit an event whose status the API would reject", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${eventId}`) {
        return hostedEvent({ status: "cancelled", availableActions: [] });
      }
      if (path === "/me/groups") return { items: [] };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <EventComposer editEventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByRole("heading", { name: "当前状态不能编辑" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "活动管理" })).toHaveAttribute(
      "href",
      "/studio/events",
    );
  });
});
