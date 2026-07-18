import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventDetailView, eventStructuredData } from "../app/components/event/EventDetail";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import {
  EventDetailClient,
  visibleEventForRoute,
} from "../app/e/[slug]/EventDetailClient";
import { apiRequest } from "../app/lib/client-api";
import { publicSafeEventDetail } from "../app/lib/event-contract";
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
  test("uses an editorial section heading instead of repeating the event title", () => {
    const event = makeDetail();
    renderWithI18n(<EventDetailView event={event} locale="zh-Hans" actions={null} />);

    expect(screen.getAllByRole("heading", { name: event.title })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "活动内容" })).toBeInTheDocument();
  });

  test("gives a first-time organizer a truthful welcome instead of a zero-history badge", () => {
    const event = makeDetail({
      organizer: {
        ...makeDetail().organizer,
        trust: { ...makeDetail().organizer.trust, completedEventCount: 0 },
      },
    });
    renderWithI18n(<EventDetailView event={event} locale="zh-Hans" actions={null} />);

    expect(screen.getAllByText("Spott 新主办方").length).toBeGreaterThan(0);
    expect(screen.queryByText("已完成 0 场活动")).not.toBeInTheDocument();
    expect(screen.queryByText(/历史到场率/)).not.toBeInTheDocument();
  });

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
      organizerContact: {
        kind: "email",
        label: "已授权活动邮箱",
        value: "authorized-host@example.jp",
      },
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
    expect(screen.getByText("已授权活动邮箱")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "发送邮件" })).toHaveAttribute(
      "href",
      "mailto:authorized-host@example.jp",
    );
    expect(screen.queryByText("报名确认后显示精确集合点")).not.toBeInTheDocument();
  });

  test("synchronously removes every old viewer-only fact when the viewer logs out", async () => {
    const authorizedSSR = makeDetail({
      exactAddress: "Old account exact address",
      coordinate: { latitude: 35.681, longitude: 139.792, precision: "exact" },
      organizerContact: {
        kind: "email",
        label: "Old account private desk",
        value: "old-account@example.jp",
      },
      registrationStatus: "confirmed",
      viewerRegistration: {
        id: "019b0000-0000-7000-8200-000000000001",
        status: "confirmed",
        partySize: 1,
        availableActions: ["viewTicket"],
        offerExpiresAt: null,
      },
      favorited: true,
      availableActions: ["viewTicket"],
      organizer: {
        ...makeDetail().organizer,
        viewerFollowing: true,
      },
    });
    actionMocks.session = {
      accessToken: "old-account-token",
      user: { id: "old-account", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${authorizedSSR.id}`
      ? authorizedSSR
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={authorizedSSR} locale="zh-Hans" />);

    expect(await screen.findByText("Old account private desk")).toBeInTheDocument();
    actionMocks.session = null;
    act(() => window.dispatchEvent(new CustomEvent("spott:session")));

    expect(screen.queryByText("Old account private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("old-account@example.jp")).not.toBeInTheDocument();
    expect(screen.queryByText("Old account exact address")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看我的报名" })).not.toBeInTheDocument();
  });

  test("never publishes an A response after switching to B", async () => {
    const serverEvent = makeDetail({
      exactAddress: "Account A SSR address",
      coordinate: { latitude: 35.681, longitude: 139.792, precision: "exact" },
      organizerContact: {
        kind: "email",
        label: "Account A SSR desk",
        value: "a-ssr@example.jp",
      },
    });
    const accountA = makeDetail({
      exactAddress: "Account A late address",
      organizerContact: {
        kind: "email",
        label: "Account A late desk",
        value: "a-late@example.jp",
      },
    });
    const accountB = makeDetail({
      exactAddress: "Account B authorized address",
      organizerContact: {
        kind: "email",
        label: "Account B authorized desk",
        value: "b@example.jp",
      },
    });
    let resolveA!: (event: typeof accountA) => void;
    let resolveB!: (event: typeof accountB) => void;
    const pendingA = new Promise<typeof accountA>((resolve) => { resolveA = resolve; });
    const pendingB = new Promise<typeof accountB>((resolve) => { resolveB = resolve; });
    let detailReads = 0;
    actionMocks.session = {
      accessToken: "account-a-token",
      user: { id: "account-a", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path !== `/events/${serverEvent.id}`) return { published: false, tags: [] };
      detailReads += 1;
      return detailReads === 1 ? pendingA : pendingB;
    });

    renderWithI18n(<EventDetailClient event={serverEvent} locale="zh-Hans" />);

    expect(screen.queryByText("Account A SSR desk")).not.toBeInTheDocument();
    expect(screen.queryByText("Account A SSR address")).not.toBeInTheDocument();
    await waitFor(() => expect(detailReads).toBe(1));
    actionMocks.session = {
      accessToken: "account-b-token",
      user: { id: "account-b", phoneVerified: true },
    };
    act(() => window.dispatchEvent(new CustomEvent("spott:session")));
    await waitFor(() => expect(detailReads).toBe(2));

    await act(async () => resolveA(accountA));
    expect(screen.queryByText("Account A late desk")).not.toBeInTheDocument();
    expect(screen.queryByText("Account A late address")).not.toBeInTheDocument();

    await act(async () => resolveB(accountB));
    expect(await screen.findByText("Account B authorized desk")).toBeInTheDocument();
    expect(screen.getByText("Account B authorized address")).toBeInTheDocument();
  });

  test("keeps the public-safe event when an authorized response has the wrong event id", async () => {
    const serverEvent = makeDetail({ organizerContact: null, exactAddress: null });
    const wrongEvent = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-cached-event",
      exactAddress: "Wrong event private address",
      organizerContact: {
        kind: "email",
        label: "Wrong event private desk",
        value: "wrong-event@example.jp",
      },
    });
    actionMocks.session = {
      accessToken: "viewer-token",
      user: { id: "viewer-user", phoneVerified: true },
    };
    apiRequestMock.mockImplementation(async (path) => path === `/events/${serverEvent.id}`
      ? wrongEvent
      : { published: false, tags: [] });

    renderWithI18n(<EventDetailClient event={serverEvent} locale="en" />, "en");

    expect(await screen.findByRole("alert")).toHaveTextContent("Events could not be loaded");
    expect(screen.queryByText("Wrong event private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-event@example.jp")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong event private address")).not.toBeInTheDocument();
    expect(screen.getByText("清澄白河站附近")).toBeInTheDocument();
  });

  test("synchronously projects route B instead of retaining route A private state before effects run", () => {
    const authorizedA = makeDetail({
      organizerContact: {
        kind: "email",
        label: "Route A private desk",
        value: "route-a@example.jp",
      },
      exactAddress: "Route A private address",
    });
    const publicB = publicSafeEventDetail(makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "route-b",
      title: "Route B",
    }));

    const visible = visibleEventForRoute(
      { routeId: authorizedA.id, event: authorizedA },
      publicB,
    );

    expect(visible.id).toBe(publicB.id);
    expect(visible.title).toBe("Route B");
    expect(visible.organizerContact).toBeNull();
    expect(visible.exactAddress).toBeNull();
    expect(JSON.stringify(visible)).not.toContain("route-a@example.jp");
    expect(JSON.stringify(visible)).not.toContain("Route A private address");
  });

  test("builds a public-safe detail without retaining an exact coordinate", () => {
    const safe = publicSafeEventDetail(makeDetail({
      exactAddress: "Private address",
      coordinate: { latitude: 35.681, longitude: 139.792, precision: "exact" },
      organizerContact: { kind: "email", label: "Private", value: "private@example.jp" },
      registrationStatus: "confirmed",
      viewerRegistration: {
        id: "019b0000-0000-7000-8200-000000000001",
        status: "confirmed",
        partySize: 1,
        availableActions: ["viewTicket"],
        offerExpiresAt: null,
      },
    }));

    expect(safe.exactAddress).toBeNull();
    expect(safe.organizerContact).toBeNull();
    expect(safe.coordinate).toBeNull();
    expect(safe.registrationStatus).toBeNull();
    expect(safe.viewerRegistration).toBeNull();
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

  test.each([
    ["zh-Hans", "联系主办方", "打开联系页面"],
    ["ja", "主催者に連絡", "連絡ページを開く"],
    ["en", "Contact the host", "Open contact page"],
  ] as const)("keeps the authorized organizer contact reachable on a %s event revisit", (locale, title, action) => {
    const event = makeDetail({
      organizerContact: {
        kind: "website",
        label: "Event safety desk",
        value: "https://example.jp/contact",
      },
    });

    renderWithI18n(
      <EventDetailView event={event} locale={locale} actions={null} />,
      locale,
    );

    const heading = screen.getByRole("heading", { name: title });
    const contactCard = heading.closest("section");
    expect(contactCard).not.toBeNull();
    expect(screen.getByText("Event safety desk")).toBeInTheDocument();
    expect(within(contactCard!).getByRole("link", { name: new RegExp(action) })).toHaveAttribute(
      "href",
      "https://example.jp/contact",
    );
    expect(within(contactCard!).getByRole("link", { name: new RegExp(action) })).toHaveAttribute("target", "_blank");
    expect(within(contactCard!).getByRole("link", { name: new RegExp(action) })).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(contactCard!).getByText("↗")).toHaveAttribute("aria-hidden", "true");
    expect(within(contactCard!).getByRole("link", { name: /举报|報告|Report/ })).toHaveAttribute(
      "href",
      `/reports/new?targetType=event&targetId=${event.id}`,
    );
  });

  test("does not invent an organizer contact when the authorized API detail returns null", () => {
    renderWithI18n(
      <EventDetailView event={makeDetail({ organizerContact: null })} locale="zh-Hans" actions={null} />,
    );

    expect(screen.queryByRole("heading", { name: "联系主办方" })).not.toBeInTheDocument();
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
