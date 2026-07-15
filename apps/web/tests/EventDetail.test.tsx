import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { EventDetailView, eventStructuredData } from "../app/components/event/EventDetail";
import { makeDetail, renderWithI18n } from "./event-fixtures";

describe("premium event detail", () => {
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
