import { formatMessage, type Locale } from "../../i18n/messages";

export type FeedbackTag =
  | "friendly"
  | "well_organized"
  | "clear_information"
  | "safe"
  | "would_join_again";

export function feedbackCopy(locale: Locale) {
  const text = (key: Parameters<typeof formatMessage>[1]) => formatMessage(locale, key);
  return {
    open: text("feedback.open"),
    close: text("feedback.close"),
    privateEyebrow: text("feedback.privateEyebrow"),
    title: text("feedback.title"),
    privacy: text("feedback.privacy"),
    rating: text("feedback.rating"),
    tags: text("feedback.tags"),
    comment: text("feedback.comment"),
    placeholder: text("feedback.placeholder"),
    visibility: text("feedback.visibility"),
    aggregate: text("feedback.aggregate"),
    hostOnly: text("feedback.hostOnly"),
    sending: text("feedback.sending"),
    submit: text("feedback.submit"),
    received: text("feedback.received"),
    points: text("feedback.points"),
    review: text("feedback.review"),
    edit: text("feedback.edit"),
    tagsByValue: {
      friendly: text("feedback.tagFriendly"),
      well_organized: text("feedback.tagWellOrganized"),
      clear_information: text("feedback.tagClearInformation"),
      safe: text("feedback.tagSafe"),
      would_join_again: text("feedback.tagWouldJoinAgain"),
    } satisfies Record<FeedbackTag, string>,
  };
}
