"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAppDialog } from "../components/AppDialog";
import { useI18n } from "../components/I18nProvider";
import type { Locale } from "../i18n/messages";
import { trackProductEvent } from "../lib/analytics";
import { apiRequest, errorMessage, readSession } from "../lib/client-api";
import type { EventView } from "../lib/demo-data";

type QuestionKind = "text" | "single_choice" | "boolean";

interface RegistrationQuestionDraft {
  key: string;
  prompt: string;
  kind: QuestionKind;
  required: boolean;
  options: string;
}

interface GroupOption {
  id: string;
  name: string;
  slug: string;
}

interface RemoteEvent {
  id: string;
  publicSlug: string;
  version: number;
  status: string;
}

interface DraftState {
  title: string;
  description: string;
  categoryId: string;
  tags: string;
  startsAt: string;
  endsAt: string;
  deadlineAt: string;
  regionId: string;
  publicArea: string;
  exactAddress: string;
  exactAddressVisibility: "public" | "confirmed";
  capacity: number;
  registrationMode: "automatic" | "approval" | "invite_only";
  waitlistEnabled: boolean;
  attendeeRequirements: string;
  registrationQuestions: RegistrationQuestionDraft[];
  isFree: boolean;
  amountJPY: string;
  collectorName: string;
  paymentMethod: string;
  paymentDeadlineText: string;
  refundPolicy: string;
  riskFlags: string[];
  riskDetails: string;
  groupId: string;
  checkinMode: "dynamic_qr" | "six_digit" | "manual";
  commentPermission: "disabled" | "participants" | "group_members";
  posterEnabled: boolean;
}

const initialDraft: DraftState = {
  title: "",
  description: "",
  categoryId: "",
  tags: "",
  startsAt: "",
  endsAt: "",
  deadlineAt: "",
  regionId: "tokyo",
  publicArea: "",
  exactAddress: "",
  exactAddressVisibility: "confirmed",
  capacity: 12,
  registrationMode: "automatic",
  waitlistEnabled: true,
  attendeeRequirements: "",
  registrationQuestions: [],
  isFree: true,
  amountJPY: "",
  collectorName: "",
  paymentMethod: "",
  paymentDeadlineText: "",
  refundPolicy: "",
  riskFlags: [],
  riskDetails: "",
  groupId: "",
  checkinMode: "dynamic_qr",
  commentPermission: "participants",
  posterEnabled: true,
};

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

const regions = [
  ["tokyo", "东京", "東京", "Tokyo"],
  ["kanagawa", "神奈川", "神奈川", "Kanagawa"],
  ["saitama", "埼玉", "埼玉", "Saitama"],
  ["chiba", "千叶", "千葉", "Chiba"],
  ["osaka", "大阪", "大阪", "Osaka"],
  ["kyoto", "京都", "京都", "Kyoto"],
] as const;

const risks = [
  ["alcohol", "酒局 / 饮酒", "飲酒", "Alcohol"],
  ["late_night", "深夜结束", "深夜終了", "Late night"],
  ["family", "亲子活动", "親子", "Family"],
  ["minors", "涉及未成年人", "未成年者", "Minors"],
  ["outdoor", "户外", "屋外", "Outdoor"],
  ["mountain", "登山", "登山", "Mountain"],
  ["water", "水上活动", "水上", "Water"],
  ["high_fee", "高金额收费", "高額参加費", "High fee"],
  ["career", "职业交流", "キャリア交流", "Career"],
  ["investment", "投资交流", "投資交流", "Investment"],
  ["gender_limited", "性别限定", "性別限定", "Gender-limited"],
] as const;

export function EventComposer() {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<DraftState>(initialDraft);
  const [remote, setRemote] = useState<RemoteEvent | null>(null);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [covers, setCovers] = useState<File[]>([]);
  const [coverPreviews, setCoverPreviews] = useState<string[]>([]);
  const [uploadedNames, setUploadedNames] = useState<string[]>([]);
  const [remoteCoverURL, setRemoteCoverURL] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState<RemoteEvent | null>(null);

  useEffect(() => {
    const session = readSession();
    if (!session) {
      window.location.replace(`/login?returnTo=${encodeURIComponent("/create")}`);
      return;
    }
    if (!session.user.phoneVerified) {
      window.location.replace(`/phone-verification?returnTo=${encodeURIComponent("/create")}`);
      return;
    }

    const saved = window.localStorage.getItem("spott.event-composer.v2");
    if (saved) {
      try {
        const value = JSON.parse(saved) as {
          draft?: Partial<DraftState> & { registrationQuestion?: string };
          remote?: RemoteEvent;
          uploadedNames?: string[];
        };
        const oldQuestion = value.draft?.registrationQuestion?.trim();
        const registrationQuestions = Array.isArray(value.draft?.registrationQuestions)
          ? value.draft.registrationQuestions
          : oldQuestion
            ? [newQuestion(oldQuestion)]
            : [];
        window.setTimeout(() => {
          setDraft({ ...initialDraft, ...value.draft, registrationQuestions });
          setUploadedNames(value.uploadedNames ?? []);
          if (value.remote) {
            setRemote(value.remote);
            void apiRequest<EventView>(`/events/${value.remote.id}`, { authenticated: true })
              .then((event) => setRemoteCoverURL(event.coverURL ?? ""))
              .catch(() => undefined);
          }
        }, 0);
      } catch {
        // Ignore a corrupted local draft and start from a safe blank state.
      }
    }

    apiRequest<{ items: GroupOption[] }>("/me/groups", { authenticated: true })
      .then((payload) => setGroups(payload.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "spott.event-composer.v2",
      JSON.stringify({ draft, remote, uploadedNames }),
    );
  }, [draft, remote, uploadedNames]);

  useEffect(
    () => () => coverPreviews.forEach((url) => URL.revokeObjectURL(url)),
    [coverPreviews],
  );

  const coverCount = covers.length + uploadedNames.length;
  const missing = useMemo(
    () => validateAll(draft, coverCount, locale),
    [coverCount, draft, locale],
  );
  const stepNames = composerSteps(locale);

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateQuestion(
    key: string,
    field: keyof Omit<RegistrationQuestionDraft, "key">,
    value: string | boolean,
  ) {
    update(
      "registrationQuestions",
      draft.registrationQuestions.map((question) =>
        question.key === key ? { ...question, [field]: value } : question,
      ),
    );
  }

  function addQuestion() {
    if (draft.registrationQuestions.length >= 10) return;
    update("registrationQuestions", [...draft.registrationQuestions, newQuestion()]);
  }

  function chooseCovers(files: FileList | null) {
    if (!files) return;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.some((file) => file.size > 20 * 1024 * 1024)) {
      setMessage(
        tr(
          locale,
          "单张图片不能超过 20MB。",
          "画像は1枚20MB以下にしてください。",
          "Each image must be 20MB or smaller.",
        ),
      );
      return;
    }
    const next = imageFiles.slice(0, Math.max(0, 6 - uploadedNames.length));
    coverPreviews.forEach((url) => URL.revokeObjectURL(url));
    setCovers(next);
    setCoverPreviews(next.map((file) => URL.createObjectURL(file)));
    setMessage("");
  }

  async function save(): Promise<RemoteEvent> {
    const body = eventPayload(draft);
    const saved = remote
      ? await apiRequest<RemoteEvent>(`/events/${remote.id}`, {
          method: "PATCH",
          authenticated: true,
          idempotent: true,
          ifMatch: remote.version,
          body: JSON.stringify(body),
        })
      : await apiRequest<RemoteEvent>("/events/drafts", {
          method: "POST",
          authenticated: true,
          idempotent: true,
          body: JSON.stringify(body),
        });
    setRemote(saved);
    await uploadPendingCovers(saved.id);
    return saved;
  }

  async function uploadPendingCovers(eventId: string) {
    const pending = covers.filter((file) => !uploadedNames.includes(file.name));
    for (const [index, file] of pending.entries()) {
      const intent = await apiRequest<{
        assetId: string;
        uploadUrl: string;
        method: string;
        requiredHeaders: Record<string, string>;
      }>("/media/upload-intents", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          purpose: "event_cover",
          filename: file.name,
          mimeType: file.type,
          byteSize: file.size,
          focalX: 0.5,
          focalY: 0.5,
        }),
      });
      const uploaded = await fetch(intent.uploadUrl, {
        method: intent.method,
        headers: intent.requiredHeaders,
        body: file,
      });
      if (!uploaded.ok)
        throw new Error(
          tr(
            locale,
            "封面上传失败，请检查网络后重试。",
            "画像をアップロードできませんでした。通信を確認してもう一度お試しください。",
            "The image upload failed. Check your connection and try again.",
          ),
        );
      const hash = await sha256(file);
      await apiRequest(`/media/${intent.assetId}/complete`, {
        method: "POST",
        authenticated: true,
        headers: { "X-Content-SHA256": hash },
      });
      await apiRequest(`/media/${intent.assetId}/attach/event/${eventId}`, {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          kind: index === 0 && uploadedNames.length === 0 ? "cover" : "gallery",
          sortOrder: uploadedNames.length + index,
        }),
      });
      setUploadedNames((names) => [...names, file.name]);
    }
  }

  async function next() {
    const currentMissing = validateStep(step, draft, coverCount, locale);
    if (currentMissing.length) {
      setMessage(
        `${tr(locale, "请先补全", "先に入力してください", "Complete these fields first")}: ${currentMissing.join(tr(locale, "、", "、", ", "))}`,
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await save();
      setStep((value) => Math.min(5, value + 1));
      setMessage(
        tr(
          locale,
          "草稿已保存到云端，可在 iOS 继续编辑。",
          "下書きをクラウドに保存しました。iOS からも続けられます。",
          "Draft saved to the cloud. You can continue on iOS.",
        ),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveAndExit() {
    setBusy(true);
    setMessage("");
    try {
      await save();
      window.location.assign("/studio/events");
    } catch (error) {
      setMessage(errorMessage(error));
      setBusy(false);
    }
  }

  async function submit() {
    if (missing.length) {
      setMessage(
        `${tr(locale, "提交前还需要补全", "提出前に入力してください", "Complete before submitting")}: ${missing.join(tr(locale, "、", "、", ", "))}`,
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const saved = await save();
      const quote = await apiRequest<{ id: string; amount: number }>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "event_publish", resourceId: saved.id }),
      });
      await appDialog.run({
        title: tr(locale, "确认提交审核", "審査提出の確認", "Confirm submission"),
        message: tr(
          locale,
          `提交审核将预留 ${quote.amount} 积分。审核拒绝或撤回会按规则退回，是否继续？`,
          `審査提出時に ${quote.amount} ポイントを一時確保します。却下・取り下げ時は規定に従い返還されます。続けますか？`,
          `Submitting reserves ${quote.amount} points. Rejected or withdrawn submissions are refunded under the policy. Continue?`,
        ),
        confirmLabel: tr(locale, "确认并提交", "確認して提出", "Confirm & submit"),
        onConfirm: async () => {
          const result = await apiRequest<RemoteEvent>(`/events/${saved.id}/submit`, {
            method: "POST",
            authenticated: true,
            idempotent: true,
            ifMatch: saved.version,
            body: JSON.stringify({ quoteId: quote.id }),
          });
          setSubmitted(result);
          void trackProductEvent("event_submission_completed", {
            eventId: result.id,
            category: draft.categoryId,
            region: draft.regionId,
            status: result.status,
          });
          window.localStorage.removeItem("spott.event-composer.v2");
        },
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (submitted)
    return (
      <main className="flow-page">
        <div className="flow-shell narrow">
          <section className="flow-card success-card">
            <span className="success-mark">✓</span>
            <span className="section-number">SUBMITTED / REVIEW</span>
            <h1>{tr(locale, "已提交审核", "審査に提出しました", "Submitted for review")}</h1>
            <p className="lead">
              {tr(
                locale,
                "活动草稿、审核状态和后续修改会在 Web 与 iOS 同步。",
                "下書き、審査状況、今後の変更は Web と iOS に同期されます。",
                "The draft, review status, and future changes stay in sync across Web and iOS.",
              )}
            </p>
            <Link className="primary-action" href="/studio/events">
              {tr(locale, "返回活动管理", "イベント管理へ", "Back to event management")}
            </Link>
            <Link className="secondary-action" href={`/e/${submitted.publicSlug}`}>
              {tr(locale, "查看活动预览", "プレビューを見る", "View event preview")}
            </Link>
          </section>
        </div>
      </main>
    );

  return (
    <main className="studio-page">
      <aside className="composer-steps">
        <Link className="wordmark" href="/">
          SPOTT
        </Link>
        <span className="eyebrow-text">
          {tr(locale, "活动发布", "イベント作成", "CREATE EVENT")}
        </span>
        <ol>
          {stepNames.map((name, index) => (
            <li
              key={name}
              className={index === step ? "active" : index < step ? "complete" : ""}
              onClick={() => index <= step && setStep(index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {name}
            </li>
          ))}
        </ol>
        <p>
          {remote
            ? `${tr(locale, "云端草稿", "クラウド下書き", "Cloud draft")} · v${remote.version}`
            : tr(locale, "尚未创建云端草稿", "クラウド未保存", "Not saved to cloud yet")}
        </p>
      </aside>

      <section className="composer-main">
        <div className="composer-top">
          <div>
            <span className="section-number">
              STEP {String(step + 1).padStart(2, "0")} / 06
            </span>
            <h1>{stepTitle(step, locale)}</h1>
            <p>{stepDescription(step, locale)}</p>
          </div>
          <button
            className="secondary-action compact"
            type="button"
            onClick={() => void saveAndExit()}
            disabled={busy}
          >
            {tr(locale, "保存并退出", "保存して終了", "Save & exit")}
          </button>
        </div>

        <div className="composer-form">
          {step === 0 && (
            <>
              <label className="form-field">
                {tr(locale, "活动分类", "カテゴリー", "Category")}
                <select
                  value={draft.categoryId}
                  onChange={(event) => update("categoryId", event.target.value)}
                >
                  <option value="">
                    {tr(locale, "选择分类", "カテゴリーを選択", "Choose a category")}
                  </option>
                  {categories.map(([value, zh, ja, en]) => (
                    <option key={value} value={value}>
                      {locale === "ja" ? ja : locale === "en" ? en : zh}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field large">
                {tr(locale, "活动标题", "イベント名", "Event title")}
                <input
                  value={draft.title}
                  onChange={(event) => update("title", event.target.value)}
                  placeholder={tr(
                    locale,
                    "4–40 字，清楚说明这是怎样的活动",
                    "4〜40文字で内容が伝わるタイトル",
                    "4–40 characters that clearly describe the event",
                  )}
                  maxLength={40}
                />
                <small>{draft.title.length} / 40</small>
              </label>
              <label className="form-field">
                {tr(locale, "活动介绍", "イベント紹介", "Description")}
                <textarea
                  rows={8}
                  value={draft.description}
                  onChange={(event) => update("description", event.target.value)}
                  placeholder={tr(
                    locale,
                    "50–3000 字：活动内容、流程、注意事项和携带物品",
                    "50〜3000文字：内容、流れ、注意事項、持ち物",
                    "50–3000 characters: agenda, expectations, notes, and what to bring",
                  )}
                  maxLength={3000}
                />
                <small>{draft.description.length} / 3000</small>
              </label>
              <label className="form-field">
                {tr(locale, "标签", "タグ", "Tags")}
                <input
                  value={draft.tags}
                  onChange={(event) => update("tags", event.target.value)}
                  placeholder={tr(
                    locale,
                    "最多 5 个，用逗号分隔",
                    "最大5件、カンマ区切り",
                    "Up to 5, separated by commas",
                  )}
                />
              </label>
              <label className="upload-placeholder cover-uploader">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  multiple
                  onChange={(event) => chooseCovers(event.target.files)}
                />
                <span>＋</span>
                <strong>
                  {tr(locale, "添加 1–6 张活动图片", "画像を1〜6枚追加", "Add 1–6 event images")}
                </strong>
                <p>
                  {tr(
                    locale,
                    "首图作为封面 · 建议 16:9 · 单张不超过 20MB",
                    "先頭がカバー · 16:9推奨 · 1枚20MBまで",
                    "First image is the cover · 16:9 recommended · 20MB each",
                  )}
                </p>
              </label>
              {uploadedNames.length > 0 && (
                <p className="upload-status">
                  ✓ {tr(locale, "已上传", "アップロード済み", "Uploaded")} {uploadedNames.length} / 6
                </p>
              )}
              {coverPreviews.length > 0 && (
                <div className="cover-preview-grid">
                  {coverPreviews.map((url, index) => (
                    <Image
                      unoptimized
                      width={480}
                      height={270}
                      key={url}
                      src={url}
                      alt={`${tr(locale, "活动图片", "イベント画像", "Event image")} ${index + 1}`}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="form-grid">
                <label className="form-field">
                  {tr(locale, "开始时间", "開始日時", "Starts")}
                  <input
                    type="datetime-local"
                    value={draft.startsAt}
                    onChange={(event) => update("startsAt", event.target.value)}
                  />
                </label>
                <label className="form-field">
                  {tr(locale, "结束时间", "終了日時", "Ends")}
                  <input
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(event) => update("endsAt", event.target.value)}
                  />
                </label>
              </div>
              <label className="form-field">
                {tr(locale, "报名截止", "申込締切", "Registration deadline")}
                <input
                  type="datetime-local"
                  value={draft.deadlineAt}
                  onChange={(event) => update("deadlineAt", event.target.value)}
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  {tr(locale, "地区", "エリア", "Area")}
                  <select
                    value={draft.regionId}
                    onChange={(event) => update("regionId", event.target.value)}
                  >
                    {regions.map(([value, zh, ja, en]) => (
                      <option key={value} value={value}>
                        {locale === "ja" ? ja : locale === "en" ? en : zh}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  {tr(locale, "公开集合范围", "公開エリア", "Public meeting area")}
                  <input
                    value={draft.publicArea}
                    onChange={(event) => update("publicArea", event.target.value)}
                    placeholder={tr(
                      locale,
                      "例如：清澄白河站附近",
                      "例：清澄白河駅周辺",
                      "e.g. near Kiyosumi-shirakawa Station",
                    )}
                  />
                </label>
              </div>
              <label className="form-field">
                {tr(locale, "精确集合地址", "正確な集合場所", "Exact meeting address")}
                <input
                  value={draft.exactAddress}
                  onChange={(event) => update("exactAddress", event.target.value)}
                  placeholder={tr(
                    locale,
                    "门牌、出口或店铺名称",
                    "住所、出口、店名など",
                    "Street address, exit, or venue name",
                  )}
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.exactAddressVisibility === "confirmed"}
                  onChange={(event) =>
                    update("exactAddressVisibility", event.target.checked ? "confirmed" : "public")
                  }
                />
                <span>
                  <strong>
                    {tr(
                      locale,
                      "仅向已确认参加者显示精确地址",
                      "確定参加者だけに正確な場所を表示",
                      "Show the exact address only to confirmed attendees",
                    )}
                  </strong>
                  <small>
                    {tr(
                      locale,
                      "未报名用户只看到公开集合范围。",
                      "未申込の人には公開エリアだけが表示されます。",
                      "Everyone else sees only the public meeting area.",
                    )}
                  </small>
                </span>
              </label>
            </>
          )}

          {step === 2 && (
            <>
              <div className="form-grid">
                <label className="form-field">
                  {tr(locale, "人数上限", "定員", "Capacity")}
                  <input
                    type="number"
                    min={2}
                    max={500}
                    value={draft.capacity}
                    onChange={(event) => update("capacity", Number(event.target.value))}
                  />
                </label>
                <label className="form-field">
                  {tr(locale, "报名方式", "申込方法", "Registration mode")}
                  <select
                    value={draft.registrationMode}
                    onChange={(event) =>
                      update("registrationMode", event.target.value as DraftState["registrationMode"])
                    }
                  >
                    <option value="automatic">
                      {tr(locale, "自动通过", "自動承認", "Automatic approval")}
                    </option>
                    <option value="approval">
                      {tr(locale, "主办方审核", "主催者が承認", "Host approval")}
                    </option>
                    <option value="invite_only">
                      {tr(locale, "仅限邀请", "招待のみ", "Invite only")}
                    </option>
                  </select>
                </label>
              </div>
              <label className="toggle-row">
                <span>
                  <strong>{tr(locale, "开启候补", "キャンセル待ち", "Enable waitlist")}</strong>
                  <small>
                    {tr(
                      locale,
                      "名额释放后按顺序递补",
                      "空席が出たら順番に案内します",
                      "Offer released spots in queue order",
                    )}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.waitlistEnabled}
                  onChange={(event) => update("waitlistEnabled", event.target.checked)}
                />
              </label>
              <label className="form-field">
                {tr(locale, "参与条件", "参加条件", "Attendee requirements")}
                <textarea
                  value={draft.attendeeRequirements}
                  onChange={(event) => update("attendeeRequirements", event.target.value)}
                  placeholder={tr(
                    locale,
                    "年龄、语言、装备等；限定条件必须说明合理原因",
                    "年齢、言語、装備など。制限には合理的な理由を記載してください",
                    "Age, language, equipment, and a clear reason for any restrictions",
                  )}
                  maxLength={2000}
                />
              </label>

              <fieldset className="question-builder">
                <legend>{tr(locale, "报名问题", "申込時の質問", "Registration questions")}</legend>
                <p>
                  {tr(
                    locale,
                    "最多 10 个，可设置必填、单选或是非题；回答会出现在主办方报名管理中。",
                    "最大10問。必須、単一選択、はい・いいえを設定でき、回答は申込管理に表示されます。",
                    "Add up to 10 text, single-choice, or yes/no questions. Answers appear in attendee management.",
                  )}
                </p>
                <div className="question-list">
                  {draft.registrationQuestions.map((question, index) => (
                    <article className="question-row" key={question.key}>
                      <div className="question-row-head">
                        <strong>
                          {tr(locale, "问题", "質問", "Question")} {index + 1}
                        </strong>
                        <button
                          type="button"
                          onClick={() =>
                            update(
                              "registrationQuestions",
                              draft.registrationQuestions.filter(
                                (candidate) => candidate.key !== question.key,
                              ),
                            )
                          }
                        >
                          {tr(locale, "删除", "削除", "Remove")}
                        </button>
                      </div>
                      <label className="form-field">
                        {tr(locale, "问题内容", "質問文", "Prompt")}
                        <input
                          maxLength={240}
                          value={question.prompt}
                          onChange={(event) =>
                            updateQuestion(question.key, "prompt", event.target.value)
                          }
                        />
                      </label>
                      <div className="form-grid">
                        <label className="form-field">
                          {tr(locale, "回答类型", "回答形式", "Answer type")}
                          <select
                            value={question.kind}
                            onChange={(event) =>
                              updateQuestion(question.key, "kind", event.target.value)
                            }
                          >
                            <option value="text">{tr(locale, "文字", "テキスト", "Text")}</option>
                            <option value="single_choice">
                              {tr(locale, "单选", "単一選択", "Single choice")}
                            </option>
                            <option value="boolean">
                              {tr(locale, "是 / 否", "はい / いいえ", "Yes / no")}
                            </option>
                          </select>
                        </label>
                        <label className="check-row compact-check">
                          <input
                            type="checkbox"
                            checked={question.required}
                            onChange={(event) =>
                              updateQuestion(question.key, "required", event.target.checked)
                            }
                          />
                          <span>
                            <strong>{tr(locale, "必须回答", "回答必須", "Required")}</strong>
                          </span>
                        </label>
                      </div>
                      {question.kind === "single_choice" && (
                        <label className="form-field">
                          {tr(locale, "选项", "選択肢", "Options")}
                          <input
                            value={question.options}
                            onChange={(event) =>
                              updateQuestion(question.key, "options", event.target.value)
                            }
                            placeholder={tr(
                              locale,
                              "至少 2 个，用逗号分隔",
                              "2件以上、カンマ区切り",
                              "At least 2, separated by commas",
                            )}
                          />
                        </label>
                      )}
                    </article>
                  ))}
                </div>
                {draft.registrationQuestions.length < 10 && (
                  <button className="secondary-action compact" type="button" onClick={addQuestion}>
                    ＋ {tr(locale, "添加问题", "質問を追加", "Add question")}
                  </button>
                )}
              </fieldset>
            </>
          )}

          {step === 3 && (
            <>
              <div className="choice-cards">
                <label className={draft.isFree ? "selected" : ""}>
                  <input
                    type="radio"
                    checked={draft.isFree}
                    onChange={() => update("isFree", true)}
                  />
                  <strong>{tr(locale, "免费活动", "無料イベント", "Free event")}</strong>
                  <span>
                    {tr(
                      locale,
                      "不向参加者收取线下活动费",
                      "参加者からオフライン費用を受け取りません",
                      "No offline event fee",
                    )}
                  </span>
                </label>
                <label className={!draft.isFree ? "selected" : ""}>
                  <input
                    type="radio"
                    checked={!draft.isFree}
                    onChange={() => update("isFree", false)}
                  />
                  <strong>{tr(locale, "收费活动", "有料イベント", "Paid event")}</strong>
                  <span>
                    {tr(
                      locale,
                      "由主办方在 App 外自行收取",
                      "主催者が App 外で直接受け取ります",
                      "Collected directly by the host outside Spott",
                    )}
                  </span>
                </label>
              </div>
              {!draft.isFree && (
                <>
                  <label className="form-field">
                    {tr(locale, "活动费（日元）", "参加費（円）", "Event fee (JPY)")}
                    <input
                      type="number"
                      min={1}
                      value={draft.amountJPY}
                      onChange={(event) => update("amountJPY", event.target.value)}
                    />
                  </label>
                  <div className="form-grid">
                    <label className="form-field">
                      {tr(locale, "收款主体", "受取主体", "Collector")}
                      <input
                        value={draft.collectorName}
                        onChange={(event) => update("collectorName", event.target.value)}
                      />
                    </label>
                    <label className="form-field">
                      {tr(locale, "App 外收款方式", "App 外の支払方法", "Payment outside Spott")}
                      <input
                        value={draft.paymentMethod}
                        onChange={(event) => update("paymentMethod", event.target.value)}
                        placeholder={tr(
                          locale,
                          "现场现金、PayPay 等",
                          "当日現金、PayPay など",
                          "Cash at venue, PayPay, etc.",
                        )}
                      />
                    </label>
                  </div>
                  <label className="form-field">
                    {tr(locale, "付款时限", "支払期限", "Payment deadline")}
                    <input
                      value={draft.paymentDeadlineText}
                      onChange={(event) => update("paymentDeadlineText", event.target.value)}
                      placeholder={tr(
                        locale,
                        "例如：活动开始前 48 小时",
                        "例：開始48時間前まで",
                        "e.g. 48 hours before the event",
                      )}
                    />
                  </label>
                  <label className="form-field">
                    {tr(locale, "取消与退款规则", "キャンセル・返金規定", "Cancellation & refund policy")}
                    <textarea
                      value={draft.refundPolicy}
                      onChange={(event) => update("refundPolicy", event.target.value)}
                      maxLength={2000}
                    />
                  </label>
                  <aside className="fee-boundary">
                    <span className="fee-icon">¥</span>
                    <div>
                      <strong>
                        {tr(
                          locale,
                          "Spott 不经手活动款",
                          "Spott は参加費を扱いません",
                          "Spott does not handle event fees",
                        )}
                      </strong>
                      <p>
                        {tr(
                          locale,
                          "费用由你向参加者说明并在 App 外收取；平台积分和线下活动费严格分离。",
                          "参加費は主催者が説明し App 外で受け取ります。ポイントと参加費は完全に分離されます。",
                          "Explain and collect the fee outside Spott. Platform points and event fees remain separate.",
                        )}
                      </p>
                    </div>
                  </aside>
                </>
              )}
              <fieldset className="risk-fieldset">
                <legend>{tr(locale, "活动风险声明", "リスク情報", "Risk disclosures")}</legend>
                <p>
                  {tr(
                    locale,
                    "按活动实际情况选择，系统会给出相应审核和安全要求。",
                    "該当項目を選択すると、必要な審査・安全要件が適用されます。",
                    "Select every relevant item so the right review and safety requirements can apply.",
                  )}
                </p>
                <div className="risk-grid">
                  {risks.map(([value, zh, ja, en]) => (
                    <label key={value} className={draft.riskFlags.includes(value) ? "selected" : ""}>
                      <input
                        type="checkbox"
                        checked={draft.riskFlags.includes(value)}
                        onChange={(event) =>
                          update(
                            "riskFlags",
                            event.target.checked
                              ? [...draft.riskFlags, value]
                              : draft.riskFlags.filter((flag) => flag !== value),
                          )
                        }
                      />
                      {locale === "ja" ? ja : locale === "en" ? en : zh}
                    </label>
                  ))}
                </div>
              </fieldset>
              {draft.riskFlags.length > 0 && (
                <label className="form-field">
                  {tr(locale, "风险控制与应急说明", "安全対策と緊急時対応", "Safety & emergency plan")}
                  <textarea
                    value={draft.riskDetails}
                    onChange={(event) => update("riskDetails", event.target.value)}
                    placeholder={tr(
                      locale,
                      "说明年龄确认、装备、天气取消、监护、紧急方案或合理限定原因",
                      "年齢確認、装備、天候中止、監督、緊急対応、制限理由など",
                      "Age checks, equipment, weather cancellation, supervision, emergencies, or restriction rationale",
                    )}
                    maxLength={1000}
                  />
                </label>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <label className="form-field">
                {tr(locale, "签到方式", "チェックイン方法", "Check-in method")}
                <select
                  value={draft.checkinMode}
                  onChange={(event) =>
                    update("checkinMode", event.target.value as DraftState["checkinMode"])
                  }
                >
                  <option value="dynamic_qr">
                    {tr(locale, "动态二维码（推荐）", "動的QR（推奨）", "Dynamic QR (recommended)")}
                  </option>
                  <option value="six_digit">
                    {tr(locale, "6 位签到码", "6桁コード", "6-digit code")}
                  </option>
                  <option value="manual">
                    {tr(locale, "主办方手动签到", "主催者が手動で記録", "Host manual check-in")}
                  </option>
                </select>
              </label>
              <label className="form-field">
                {tr(locale, "关联群组", "関連グループ", "Linked group")}
                <select value={draft.groupId} onChange={(event) => update("groupId", event.target.value)}>
                  <option value="">
                    {tr(locale, "不关联群组", "グループなし", "No linked group")}
                  </option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                {tr(locale, "评论权限", "コメント権限", "Comment access")}
                <select
                  value={draft.commentPermission}
                  onChange={(event) =>
                    update(
                      "commentPermission",
                      event.target.value as DraftState["commentPermission"],
                    )
                  }
                >
                  <option value="participants">
                    {tr(locale, "仅参加者", "参加者のみ", "Attendees only")}
                  </option>
                  <option value="group_members">
                    {tr(locale, "关联群成员", "関連グループのメンバー", "Linked group members")}
                  </option>
                  <option value="disabled">
                    {tr(locale, "关闭评论", "コメントを無効化", "Disable comments")}
                  </option>
                </select>
              </label>
              <label className="toggle-row">
                <span>
                  <strong>{tr(locale, "生成分享海报", "共有ポスターを生成", "Generate share poster")}</strong>
                  <small>
                    {tr(
                      locale,
                      "提交后自动生成适合社交平台的活动分享图",
                      "提出後、SNS向け画像を自動生成します",
                      "Create a social-ready event image after submission",
                    )}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.posterEnabled}
                  onChange={(event) => update("posterEnabled", event.target.checked)}
                />
              </label>
            </>
          )}

          {step === 5 && (
            <>
              <div className="review-summary">
                <span className="section-number">PREVIEW</span>
                <h2>{draft.title || tr(locale, "活动标题", "イベント名", "Event title")}</h2>
                <p>{draft.description || tr(locale, "活动介绍", "イベント紹介", "Description")}</p>
                <dl>
                  <div>
                    <dt>{tr(locale, "时间", "日時", "Date")}</dt>
                    <dd>
                      {draft.startsAt
                        ? new Intl.DateTimeFormat(intlLocale(locale), {
                            dateStyle: "long",
                            timeStyle: "short",
                          }).format(new Date(draft.startsAt))
                        : tr(locale, "待填写", "未入力", "Not set")}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr(locale, "地点", "場所", "Place")}</dt>
                    <dd>{draft.publicArea || tr(locale, "待填写", "未入力", "Not set")}</dd>
                  </div>
                  <div>
                    <dt>{tr(locale, "人数", "定員", "Capacity")}</dt>
                    <dd>
                      {draft.capacity} {t("common.people")} · {registrationModeLabel(draft.registrationMode, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr(locale, "费用", "参加費", "Fee")}</dt>
                    <dd>
                      {draft.isFree
                        ? t("common.free")
                        : `¥${Number(draft.amountJPY || 0).toLocaleString()}`}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="submission-checklist">
                <h3>{tr(locale, "提交检查", "提出前チェック", "Submission check")}</h3>
                {missing.length ? (
                  missing.map((item) => (
                    <p key={item} className="missing">
                      ○ {item}
                    </p>
                  ))
                ) : (
                  <p className="ready">
                    ✓ {tr(locale, "所有必填项已完成", "必須項目はすべて完了", "All required fields are complete")}
                  </p>
                )}
                <p>
                  {tr(
                    locale,
                    "提交后普通活动进入自动审核与抽样复核；高风险活动进入人工审核。",
                    "通常イベントは自動審査と抽出確認、リスクが高い場合は人による審査に進みます。",
                    "Standard events use automated and sampled review; higher-risk events go to manual review.",
                  )}
                </p>
              </div>
            </>
          )}

          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
          <div className="composer-actions">
            <button
              className="secondary-action compact"
              type="button"
              onClick={() => setStep((value) => Math.max(0, value - 1))}
              disabled={step === 0 || busy}
            >
              {tr(locale, "上一步", "戻る", "Back")}
            </button>
            <span>
              {remote
                ? `${tr(locale, "云端版本", "クラウド版", "Cloud version")} ${remote.version}`
                : tr(locale, "尚未保存", "未保存", "Not saved")}
            </span>
            {step < 5 ? (
              <button
                className="primary-action compact"
                type="button"
                onClick={() => void next()}
                disabled={busy}
              >
                {busy
                  ? tr(locale, "正在保存…", "保存中…", "Saving…")
                  : tr(locale, "保存并继续 →", "保存して次へ →", "Save & continue →")}
              </button>
            ) : (
              <button
                className="primary-action compact"
                type="button"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy
                  ? tr(locale, "正在提交…", "提出中…", "Submitting…")
                  : tr(locale, "确认积分并提交审核", "ポイントを確認して提出", "Confirm points & submit")}
              </button>
            )}
          </div>
        </div>
      </section>

      <aside className="composer-preview">
        <span className="section-number">
          {tr(locale, "实时预览", "ライブプレビュー", "LIVE PREVIEW")}
        </span>
        <div className="phone-preview">
          {coverPreviews[0] || remoteCoverURL ? (
            <Image
              unoptimized
              width={480}
              height={360}
              className="preview-cover-image"
              src={coverPreviews[0] || remoteCoverURL}
              alt={tr(locale, "封面预览", "カバープレビュー", "Cover preview")}
            />
          ) : (
            <div className="preview-cover">
              <span>YOUR EVENT</span>
            </div>
          )}
          <div>
            <span>
              {draft.startsAt
                ? new Intl.DateTimeFormat(intlLocale(locale), {
                    month: "long",
                    day: "numeric",
                  }).format(new Date(draft.startsAt))
                : tr(locale, "日期待定", "日程未定", "Date TBA")}{" "}
              · {regionLabel(draft.regionId, locale)}
            </span>
            <h3>{draft.title || tr(locale, "你的活动标题", "イベント名", "Your event title")}</h3>
            <p>
              {draft.description ||
                tr(
                  locale,
                  "活动说明会在这里形成一个清晰、可分享的页面。",
                  "イベントの説明が、分かりやすく共有できるページになります。",
                  "Your description becomes a clear, shareable event page.",
                )}
            </p>
          </div>
        </div>
      </aside>
    </main>
  );
}

function newQuestion(prompt = ""): RegistrationQuestionDraft {
  return {
    key:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    prompt,
    kind: "text",
    required: false,
    options: "",
  };
}

function eventPayload(draft: DraftState) {
  const title = draft.title.trim();
  const riskDetails = Object.fromEntries(
    draft.riskFlags.map((flag) => [flag, draft.riskDetails.trim()]),
  );
  return {
    ...(title ? { title } : {}),
    description: draft.description.trim(),
    categoryId: draft.categoryId,
    tags: draft.tags
      .split(/[，,、]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 5),
    startsAt: toISO(draft.startsAt),
    endsAt: toISO(draft.endsAt),
    deadlineAt: toISO(draft.deadlineAt),
    regionId: draft.regionId,
    publicArea: draft.publicArea.trim(),
    exactAddress: draft.exactAddress.trim(),
    exactAddressVisibility: draft.exactAddressVisibility,
    capacity: draft.capacity,
    registrationMode: draft.registrationMode,
    waitlistEnabled: draft.waitlistEnabled,
    attendeeRequirements: draft.attendeeRequirements.trim(),
    registrationQuestions: draft.registrationQuestions
      .filter((question) => question.prompt.trim())
      .map((question) => ({
        prompt: question.prompt.trim(),
        kind: question.kind,
        required: question.required,
        options:
          question.kind === "single_choice"
            ? question.options
                .split(/[，,、]/)
                .map((option) => option.trim())
                .filter(Boolean)
                .slice(0, 12)
            : [],
      })),
    fee: draft.isFree
      ? { isFree: true }
      : {
          isFree: false,
          amountJPY: Number(draft.amountJPY),
          collectorName: draft.collectorName.trim(),
          method: draft.paymentMethod.trim(),
          paymentDeadlineText: draft.paymentDeadlineText.trim(),
          refundPolicy: draft.refundPolicy.trim(),
        },
    riskFlags: draft.riskFlags,
    riskDetails,
    groupId: draft.groupId || null,
    checkinMode: draft.checkinMode,
    commentPermission: draft.commentPermission,
    posterEnabled: draft.posterEnabled,
  };
}

function validateStep(
  step: number,
  draft: DraftState,
  coverCount: number,
  locale: Locale,
): string[] {
  if (step === 0)
    return [
      draft.title.trim().length < 4
        ? tr(locale, "4–40 字活动标题", "4〜40文字のイベント名", "A 4–40 character title")
        : "",
      draft.description.trim().length < 50
        ? tr(locale, "至少 50 字活动介绍", "50文字以上の紹介", "A description of at least 50 characters")
        : "",
      !draft.categoryId ? tr(locale, "活动分类", "カテゴリー", "Category") : "",
      coverCount < 1 ? tr(locale, "至少 1 张封面", "カバー画像1枚以上", "At least one cover image") : "",
    ].filter(Boolean);
  if (step === 1)
    return [
      !draft.startsAt ? tr(locale, "开始时间", "開始日時", "Start time") : "",
      !draft.endsAt || new Date(draft.endsAt) <= new Date(draft.startsAt)
        ? tr(locale, "正确的结束时间", "正しい終了日時", "A valid end time")
        : "",
      !draft.deadlineAt || new Date(draft.deadlineAt) > new Date(draft.startsAt)
        ? tr(
            locale,
            "不晚于开始时间的报名截止",
            "開始前の申込締切",
            "A registration deadline before the event",
          )
        : "",
      !draft.publicArea ? tr(locale, "公开集合范围", "公開エリア", "Public meeting area") : "",
      !draft.exactAddress ? tr(locale, "精确集合地址", "正確な集合場所", "Exact address") : "",
    ].filter(Boolean);
  if (step === 2) {
    const invalidQuestion = draft.registrationQuestions.find(
      (question) =>
        !question.prompt.trim() ||
        (question.kind === "single_choice" &&
          question.options
            .split(/[，,、]/)
            .map((option) => option.trim())
            .filter(Boolean).length < 2),
    );
    return [
      draft.capacity < 2 || draft.capacity > 500
        ? tr(locale, "2–500 人的人数上限", "2〜500人の定員", "Capacity between 2 and 500")
        : "",
      invalidQuestion
        ? tr(
            locale,
            "完整的报名问题（单选题至少 2 个选项）",
            "質問文と、単一選択の場合は2件以上の選択肢",
            "Complete questions, with at least 2 options for single choice",
          )
        : "",
    ].filter(Boolean);
  }
  if (step === 3)
    return [
      !draft.isFree && !draft.amountJPY
        ? tr(locale, "活动费金额", "参加費", "Event fee")
        : "",
      !draft.isFree && !draft.collectorName
        ? tr(locale, "收款主体", "受取主体", "Collector")
        : "",
      !draft.isFree && !draft.paymentMethod
        ? tr(locale, "App 外收款方式", "App 外の支払方法", "Payment method outside Spott")
        : "",
      !draft.isFree && !draft.refundPolicy
        ? tr(locale, "取消退款规则", "キャンセル・返金規定", "Cancellation and refund policy")
        : "",
      draft.riskFlags.length > 0 && !draft.riskDetails.trim()
        ? tr(locale, "风险控制与应急说明", "安全対策と緊急時対応", "Safety and emergency plan")
        : "",
    ].filter(Boolean);
  return [];
}

function validateAll(draft: DraftState, coverCount: number, locale: Locale): string[] {
  return [0, 1, 2, 3].flatMap((step) => validateStep(step, draft, coverCount, locale));
}

function composerSteps(locale: Locale): string[] {
  return locale === "ja"
    ? ["基本情報", "日時と場所", "申込設定", "費用と安全", "当日とグループ", "確認と提出"]
    : locale === "en"
      ? ["Basics", "Time & place", "Registration", "Fees & risk", "On-site & group", "Review & submit"]
      : ["基本信息", "时间地点", "报名设置", "费用风险", "现场社群", "预览提交"];
}

function stepTitle(step: number, locale: Locale): string {
  const values =
    locale === "ja"
      ? [
          "イベントを明確に伝える。",
          "いつ、どこで会うか。",
          "誰が、どう参加するか。",
          "費用とリスクを先に示す。",
          "当日と、その後をつなぐ。",
          "確認して、審査へ。",
        ]
      : locale === "en"
        ? [
            "Make the event clear.",
            "Set when and where.",
            "Decide who can join.",
            "Put fees and risks up front.",
            "Connect the day and what follows.",
            "Review, then submit.",
          ]
        : [
            "先把活动说清楚。",
            "确定何时、在哪里见面。",
            "决定谁能参加。",
            "把费用与风险说在前面。",
            "连接现场与活动之后。",
            "检查无误，再提交审核。",
          ];
  return values[step] ?? tr(locale, "创建活动", "イベント作成", "Create event");
}

function stepDescription(step: number, locale: Locale): string {
  const values =
    locale === "ja"
      ? [
          "タイトル、紹介、カテゴリー、画像が公開ページを作ります。",
          "正確な場所は確定参加者だけに表示できます。",
          "定員、承認方法、キャンセル待ち、申込時の質問を設定します。",
          "Spott は参加費を扱いません。リスクのある活動には追加説明が必要です。",
          "チェックイン、グループ、コメント、共有ポスターを設定します。",
          "不足項目とリスク情報を確認し、最新のポイント見積もりを取得します。",
        ]
      : locale === "en"
        ? [
            "The title, description, category, and images form the public page.",
            "You can reveal the exact location only to confirmed attendees.",
            "Set capacity, approval, waitlist, and registration questions.",
            "Spott does not handle offline fees. Riskier events need more detail.",
            "Configure check-in, groups, comments, and the share poster.",
            "We check required and risk fields, then generate a live points quote.",
          ]
        : [
            "标题、介绍、分类与图片会构成公开活动页。",
            "精确地址可只向已确认参加者展示。",
            "设置人数、通过方式、候补和报名问题。",
            "Spott 不经手线下活动款，风险活动需要额外说明。",
            "签到、群组、评论和分享海报都在这里设置。",
            "系统会检查缺失项和风险字段，再生成实时积分报价。",
          ];
  return values[step] ?? "";
}

function registrationModeLabel(mode: DraftState["registrationMode"], locale: Locale): string {
  if (mode === "approval") return tr(locale, "主办方审核", "主催者承認", "Host approval");
  if (mode === "invite_only") return tr(locale, "仅限邀请", "招待のみ", "Invite only");
  return tr(locale, "自动通过", "自動承認", "Automatic approval");
}

function regionLabel(value: string, locale: Locale): string {
  const region = regions.find(([id]) => id === value);
  if (!region) return value;
  return locale === "ja" ? region[2] : locale === "en" ? region[3] : region[1];
}

function intlLocale(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}

function tr(locale: Locale, zh: string, ja: string, en: string): string {
  return locale === "ja" ? ja : locale === "en" ? en : zh;
}

function toISO(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

async function sha256(file: File): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
