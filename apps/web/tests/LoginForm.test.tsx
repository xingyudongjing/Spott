import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { LoginForm } from "../app/login/LoginForm";
import { renderWithI18n } from "./event-fixtures";

describe("login legal consent", () => {
  test.each([
    ["zh-Hans", "服务条款", "隐私政策"],
    ["ja", "利用規約", "プライバシーポリシー"],
    ["en", "Terms", "Privacy Policy"],
  ] as const)("links to both legal documents in %s", (locale, terms, privacy) => {
    renderWithI18n(<LoginForm />, locale);

    expect(screen.getByRole("link", { name: terms })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: privacy })).toHaveAttribute("href", "/privacy");
  });
});
