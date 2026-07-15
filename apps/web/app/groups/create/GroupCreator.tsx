"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useAppDialog } from "../../components/AppDialog";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage, readSession, type GroupView } from "../../lib/client-api";

const regions = [
  ["nationwide", "全国", "全国", "Nationwide"],
  ["tokyo", "东京", "東京", "Tokyo"],
  ["kanagawa", "神奈川", "神奈川", "Kanagawa"],
  ["saitama", "埼玉", "埼玉", "Saitama"],
  ["chiba", "千叶", "千葉", "Chiba"],
  ["osaka", "大阪", "大阪", "Osaka"],
  ["kyoto", "京都", "京都", "Kyoto"],
] as const;

const categories = [
  ["walk", "城市漫步", "街歩き", "City walks"],
  ["music", "音乐", "音楽", "Music"],
  ["outdoor", "户外", "アウトドア", "Outdoors"],
  ["art", "创作", "アート", "Arts"],
  ["language", "语言交换", "言語交流", "Language exchange"],
  ["food", "美食与咖啡", "食とカフェ", "Food & coffee"],
  ["sports", "运动", "スポーツ", "Sports"],
  ["games", "桌游", "ゲーム", "Games"],
  ["learning", "学习", "学び", "Learning"],
  ["wellness", "身心健康", "ウェルネス", "Wellness"],
  ["networking", "职业交流", "キャリア交流", "Networking"],
  ["volunteering", "志愿活动", "ボランティア", "Volunteering"],
] as const;

export function GroupCreator() {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [joinMode, setJoinMode] = useState<GroupView["joinMode"]>("open");
  const [regionId, setRegionId] = useState("nationwide");
  const [categoryId, setCategoryId] = useState("");
  const [tags, setTags] = useState("");
  const [rules, setRules] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<GroupView | null>(null);

  useEffect(() => {
    const session = readSession();
    const path = "/groups/create";
    if (!session) window.location.replace(`/login?returnTo=${encodeURIComponent(path)}`);
    else if (!session.user.phoneVerified)
      window.location.replace(`/phone-verification?returnTo=${encodeURIComponent(path)}`);
  }, []);

  const tagList = useMemo(
    () =>
      tags
        .split(/[,，、]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 5),
    [tags],
  );

  const copy =
    locale === "ja"
      ? {
          created: "グループを作成しました",
          createdBody: "同じアカウントで Web と iOS の両方から運営できます。",
          intro:
            "参加者が安心して選べるように、目的、活動内容、参加方法、コミュニティルールを明確にしましょう。",
          name: "グループ名",
          link: "公開リンク",
          description: "グループ紹介",
          descriptionHint: "目的、どんな人が集まり、普段どんな活動をするかを20文字以上で説明してください。",
          region: "主な地域",
          category: "カテゴリー",
          chooseCategory: "カテゴリーを選択",
          tags: "タグ（最大5個）",
          tagsHint: "例：初心者歓迎、週末、写真",
          join: "参加方法",
          rules: "コミュニティルール",
          rulesHint: "歓迎する行動、禁止事項、キャンセルや安全に関するルールを明記してください。",
          open: "誰でも参加",
          approval: "承認制",
          invite: "招待のみ",
          count: `${tagList.length} / 5 タグ`,
          quoteConfirm: (amount: number) =>
            `${amount}ポイントを使ってこのグループを作成しますか？見積もりは15分間有効です。`,
        }
      : locale === "en"
        ? {
            created: "Group created",
            createdBody: "Run it from both Web and iOS with the same account.",
            intro:
              "Give people enough context to join with confidence: purpose, activities, membership, and community rules.",
            name: "Group name",
            link: "Public link",
            description: "Group description",
            descriptionHint: "In at least 20 characters, explain the purpose, who it is for, and what you do together.",
            region: "Primary region",
            category: "Category",
            chooseCategory: "Choose a category",
            tags: "Tags (up to 5)",
            tagsHint: "e.g. beginner-friendly, weekends, photography",
            join: "Join mode",
            rules: "Community rules",
            rulesHint: "Set expectations for conduct, cancellations, prohibited behavior, and safety.",
            open: "Open",
            approval: "Approval required",
            invite: "Invite only",
            count: `${tagList.length} / 5 tags`,
            quoteConfirm: (amount: number) =>
              `Use ${amount} points to create this group? The quote is valid for 15 minutes.`,
          }
        : {
            created: "群组已创建",
            createdBody: "现在可以用同一账号在 Web 与 iOS 两端管理。",
            intro: "让用户能放心决定是否加入：请清楚说明群组目的、日常活动、加入方式和社区规则。",
            name: "群组名称",
            link: "公开链接",
            description: "群组介绍",
            descriptionHint: "至少 20 个字符，说明群组目的、适合什么人以及通常会一起做什么。",
            region: "主要地区",
            category: "群组分类",
            chooseCategory: "选择分类",
            tags: "标签（最多 5 个）",
            tagsHint: "例如：新手友好、周末、摄影",
            join: "加入方式",
            rules: "社区规则",
            rulesHint: "写明友善行为、禁止事项、取消约定和安全要求。",
            open: "公开加入",
            approval: "审核加入",
            invite: "仅限邀请",
            count: `${tagList.length} / 5 个标签`,
            quoteConfirm: (amount: number) =>
              `创建这个群组需要 ${amount} 积分，是否继续？报价 15 分钟内有效。`,
          };

  function updateName(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const quote = await apiRequest<{ id: string; amount: number; currency: "POINTS"; expiresAt: string }>(
        "/quotes",
        {
          method: "POST",
          authenticated: true,
          body: JSON.stringify({ purpose: "group_create" }),
        },
      );
      await appDialog.run({
        title: t("group.create"),
        message: copy.quoteConfirm(quote.amount),
        confirmLabel: t("group.create"),
        onConfirm: async () => {
          const result = await apiRequest<GroupView>("/groups", {
            method: "POST",
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({
              quoteId: quote.id,
              name: name.trim(),
              slug,
              description: description.trim(),
              joinMode,
              regionId,
              categoryId,
              tags: tagList,
              rules: rules.trim(),
            }),
          });
          setCreated(result);
        },
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (created)
    return (
      <main className="flow-page">
        <div className="flow-shell narrow">
          <section className="flow-card success-card">
            <span className="success-mark">✓</span>
            <h1>{copy.created}</h1>
            <p className="lead">{copy.createdBody}</p>
            <Link className="primary-action" href={`/g/${created.slug}`}>
              {t("common.open")}
            </Link>
          </section>
        </div>
      </main>
    );

  return (
    <main className="flow-page">
      <div className="flow-shell">
        <Link className="back-link" href="/groups">
          ← {t("group.directory")}
        </Link>
        <form className="flow-card group-create-card" onSubmit={submit}>
          <span className="section-number">NEW COMMUNITY</span>
          <h1>{t("group.create")}</h1>
          <p className="lead">{copy.intro}</p>

          <label className="form-field">
            {copy.name}
            <input
              required
              minLength={2}
              maxLength={30}
              value={name}
              onChange={(event) => updateName(event.target.value)}
            />
            <small>{name.length} / 30</small>
          </label>
          <label className="form-field">
            {copy.link}
            <div className="slug-input">
              <span>spott.jp/g/</span>
              <input
                required
                pattern="[a-z0-9-]{3,80}"
                value={slug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
              />
            </div>
          </label>
          <label className="form-field">
            {copy.description}
            <textarea
              required
              minLength={20}
              maxLength={1000}
              rows={6}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={copy.descriptionHint}
            />
            <small>{description.length} / 1000</small>
          </label>
          <div className="form-grid">
            <label className="form-field">
              {copy.region}
              <select value={regionId} onChange={(event) => setRegionId(event.target.value)}>
                {regions.map(([value, zh, ja, en]) => (
                  <option key={value} value={value}>
                    {locale === "ja" ? ja : locale === "en" ? en : zh}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              {copy.category}
              <select
                required
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">{copy.chooseCategory}</option>
                {categories.map(([value, zh, ja, en]) => (
                  <option key={value} value={value}>
                    {locale === "ja" ? ja : locale === "en" ? en : zh}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="form-field">
            {copy.tags}
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={copy.tagsHint}
            />
            <small>{copy.count}</small>
          </label>
          <label className="form-field">
            {copy.join}
            <select
              value={joinMode}
              onChange={(event) => setJoinMode(event.target.value as GroupView["joinMode"])}
            >
              <option value="open">{copy.open}</option>
              <option value="approval">{copy.approval}</option>
              <option value="invite_only">{copy.invite}</option>
            </select>
          </label>
          <label className="form-field">
            {copy.rules}
            <textarea
              maxLength={4000}
              rows={6}
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              placeholder={copy.rulesHint}
            />
            <small>{rules.length} / 4000</small>
          </label>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          <button className="primary-action" disabled={busy}>
            {busy ? t("common.loading") : t("group.create")}
          </button>
        </form>
      </div>
    </main>
  );
}

function slugify(value: string): string {
  const normalized = value.trim().normalize("NFKC");
  if (!normalized) return "";
  const readable = normalized
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (readable.length >= 3) return readable;

  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `group-${(hash >>> 0).toString(36)}`;
}
