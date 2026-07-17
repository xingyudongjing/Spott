import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventDetailView, eventStructuredData } from "../app/components/event/EventDetail";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { EventDetailClient } from "../app/e/[slug]/EventDetailClient";
import { apiRequest } from "../app/lib/client-api";
import { fetchEvent } from "../app/lib/events-api";
import { makeDetail, renderWithI18n } from "./event-fixtures";

const actionMocks = vi.hoisted(() => ({
  session: null as null | {
    accessToken: string;
    user: { id: string; phoneVerified: boolean };
  },
  apiRequest: vi.fn(),
  fetchEvent: vi.fn(),
  trackProductEvent: vi.fn(),
}));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return {
    ...actual,
    apiRequest: actionMocks.apiRequest,
    readSession: () => actionMocks.session,
  };
});
vi.mock("../app/lib/events-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/events-api")>();
  return { ...actual, fetchEvent: actionMocks.fetchEvent };
});
vi.mock("../app/lib/analytics", () => ({ trackProductEvent: actionMocks.trackProductEvent }));

const fetchEventMock = vi.mocked(fetchEvent);
const apiRequestMock = vi.mocked(apiRequest);

beforeEach(() => {
  actionMocks.session = null;
  apiRequestMock.mockReset();
  fetchEventMock.mockReset();
  actionMocks.trackProductEvent.mockReset();
});

describe("premium event detail", () => {
  test("hydrates anonymous SSR actions with the signed-in viewer event before choosing the CTA", async () => {
    const anonymousEvent = makeDetail({ availableActions: [], registrationMode: "approval" });
    const viewerEvent = makeDetail({ availableActions: ["register"], registrationMode: "approval" });
    actionMocks.session = {
      accessToken: "viewer-access-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${anonymousEvent.id}`
      ? viewerEvent
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={anonymousEvent} locale="zh-Hans" />);

    expect(await screen.findByRole("link", { name: "申请参加" })).toHaveAttribute(
      "href",
      `/register/${anonymousEvent.publicSlug}`,
    );
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${anonymousEvent.id}`,
      { authenticated: true },
    );
    expect(fetchEventMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "报名已关闭" })).not.toBeInTheDocument();
  });

  test("loads viewer-authorized event state through the refresh-aware client API", async () => {
    const anonymousEvent = makeDetail({ availableActions: [], registrationMode: "approval" });
    const viewerEvent = makeDetail({ availableActions: ["register"], registrationMode: "approval" });
    actionMocks.session = {
      accessToken: "expired-access-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${anonymousEvent.id}`
      ? viewerEvent
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={anonymousEvent} locale="zh-Hans" />);

    expect(await screen.findByRole("link", { name: "申请参加" })).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${anonymousEvent.id}`,
      { authenticated: true },
    );
  });

  test("records one detail view while replacing public facts with viewer-authorized facts", async () => {
    const anonymousEvent = makeDetail({ availableActions: [] });
    const viewerEvent = makeDetail({ availableActions: ["register"] });
    actionMocks.session = {
      accessToken: "viewer-access-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${anonymousEvent.id}`
      ? viewerEvent
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={anonymousEvent} locale="zh-Hans" />);
    await screen.findByRole("link", { name: "报名参加" });

    await waitFor(() => {
      expect(actionMocks.trackProductEvent.mock.calls.filter(
        ([name]) => name === "event_detail_viewed",
      )).toHaveLength(1);
    });
  });

  test("does not hydrate viewer facts or emit analytics in the public read-only preview", async () => {
    const event = makeDetail({ availableActions: [] });
    actionMocks.session = {
      accessToken: "viewer-access-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockResolvedValue({ published: false, tags: [] });

    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventDetailClient event={event} locale="zh-Hans" />
      </PreviewModeProvider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument());
    expect(actionMocks.trackProductEvent).not.toHaveBeenCalled();
    expect(apiRequestMock).not.toHaveBeenCalledWith(
      `/events/${event.id}`,
      { authenticated: true },
    );
  });

  test("renders viewer-only facts and the CTA from the same authorized event", async () => {
    const anonymousEvent = makeDetail({
      exactAddress: null,
      availableActions: [],
      registrationMode: "approval",
    });
    const viewerEvent = makeDetail({
      exactAddress: "东京都江东区平野 1-2-3",
      availableActions: ["viewTicket"],
      viewerRegistration: {
        id: "019b0000-0000-7000-8200-000000000001",
        status: "confirmed",
        partySize: 1,
        availableActions: ["viewTicket"],
        offerExpiresAt: null,
      },
    });
    actionMocks.session = {
      accessToken: "viewer-access-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${anonymousEvent.id}`
      ? viewerEvent
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={anonymousEvent} locale="zh-Hans" />);

    expect(await screen.findByRole("link", { name: "查看我的报名" })).toBeInTheDocument();
    expect(screen.getByText("东京都江东区平野 1-2-3")).toBeInTheDocument();
    expect(screen.queryByText("报名确认后显示精确集合点")).not.toBeInTheDocument();
  });

  test("keeps public JSON-LD server-rendered while a client boundary owns viewer facts", () => {
    const pageSource = readFileSync(resolve(process.cwd(), "app/e/[slug]/page.tsx"), "utf8");

    expect(pageSource).toContain("EventDetailClient");
    expect(pageSource).toContain("eventStructuredData(event)");
  });

  test("pins the mobile primary action to the bottom without inheriting the desktop top offset", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "app/components/event/EventDetail.module.css"),
      "utf8",
    );
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 780px)"));

    expect(mobileStyles).toMatch(/\.actionSlot\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*auto;[\s\S]*?bottom:\s*0;/);
    expect(mobileStyles).toContain("env(safe-area-inset-bottom)");
  });

  test("answers the seven decision facts in the first viewport without fabricated claims", () => {
    renderWithI18n(
      <EventDetailView
        event={makeDetail()}
        locale="zh-Hans"
        actions={<button type="button">报名参加</button>}
      />,
    );

    const firstViewport = screen.getByTestId("event-first-viewport");
    expect(within(firstViewport).getByRole("heading", { level: 1 })).toHaveTextContent("东京余光");
    expect(firstViewport).toHaveTextContent("7月18日周六");
    expect(firstViewport).toHaveTextContent("清澄白河站附近");
    expect(firstViewport).toHaveTextContent("免费");
    expect(firstViewport).toHaveTextContent("周末开局");
    expect(firstViewport).toHaveTextContent("余 13");
    expect(firstViewport).toHaveTextContent("线下");
    expect(firstViewport).toHaveTextContent("日语");
    expect(firstViewport).toHaveTextContent("英语");
    expect(firstViewport).toHaveTextContent("语言已确认");
    expect(firstViewport).not.toHaveTextContent(/reliability|评分|星级|boundaryStatement/i);
  });

  test("renders public and authorized address facts without exposing coordinates", () => {
    const { rerender } = renderWithI18n(
      <EventDetailView event={makeDetail()} locale="zh-Hans" actions={null} />,
    );
    expect(screen.getByText("清澄白河站附近")).toBeInTheDocument();
    expect(screen.getByText("报名确认后显示精确集合点")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("35.68");

    rerender(
      <EventDetailView
        event={makeDetail({ exactAddress: "东京都江东区平野 1-2-3" })}
        locale="zh-Hans"
        actions={null}
      />,
    );
    const exactAddress = screen.getByText("东京都江东区平野 1-2-3");
    expect(exactAddress).toBeInTheDocument();
    expect(exactAddress.parentElement).toHaveTextContent("仅向有权限的参加者显示");
  });

  test("shows only contract-backed organizer trust and language facts", () => {
    renderWithI18n(
      <EventDetailView event={makeDetail()} locale="zh-Hans" actions={null} />,
    );

    expect(screen.getAllByText("手机已验证")).not.toHaveLength(0);
    expect(screen.getByText("已完成 18 场活动")).toBeInTheDocument();
    expect(screen.getByText("历史到场率 90% 以上")).toBeInTheDocument();
    expect(screen.queryByText(/可靠度|评分|好评/)).not.toBeInTheDocument();
  });

  test("keeps JSON-LD public even when an authorized exact address is present", () => {
    const event = makeDetail({
      exactAddress: "东京都江东区平野 1-2-3",
      coordinate: { latitude: 35.68, longitude: 139.79, precision: "exact" },
    });
    const json = JSON.stringify(eventStructuredData(event));

    expect(json).toContain("清澄白河站附近");
    expect(json).not.toContain("平野 1-2-3");
    expect(json).not.toContain("35.68");
    expect(json).toContain("OfflineEventAttendanceMode");
  });

  test("describes online and hybrid format truthfully without join information", () => {
    const online = JSON.stringify(eventStructuredData(makeDetail({ format: "online", publicArea: null })));
    const hybrid = JSON.stringify(eventStructuredData(makeDetail({ format: "hybrid" })));

    expect(online).toContain("OnlineEventAttendanceMode");
    expect(online).not.toContain("location");
    expect(hybrid).toContain("MixedEventAttendanceMode");
  });
});
