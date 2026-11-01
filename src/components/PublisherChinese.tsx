import type { ReactNode } from "react";
import { parseTags, renderVariant, usage, xiaohongshuTitleLength } from "@/lib/publisher/variants";

export interface ChineseDraft {
  title: string;
  text: string;
  /** Free text such as "#生活美学 #旅行", parsed when sent. */
  topics: string;
}
interface Props {
  value: ChineseDraft;
  onChange: (value: ChineseDraft) => void;
  onTranslate: () => void;
  translating: boolean;
  canTranslate: boolean;
  disabled: boolean;
  /** The composer's Chinese version of the video. */
  children?: ReactNode;
}
/** Xiaohongshu publishes its own Simplified Chinese title, text and topics. */
export default function PublisherChinese({
  value,
  onChange,
  onTranslate,
  translating,
  canTranslate,
  disabled,
  children,
}: Props) {
  const set = (patch: Partial<ChineseDraft>) => onChange({ ...value, ...patch });
  const titleLength = xiaohongshuTitleLength(value.title);
  // Topics count toward the text limit, so the counter includes them.
  const zh = { title: value.title, text: value.text, topics: parseTags(value.topics) };
  const text = usage("xiaohongshu", renderVariant("xiaohongshu", { title: "", caption: "", zh }))[1];
  return (
    <fieldset className="publisher-zh">
      <legend>Xiaohongshu · Chinese</legend>
      <button type="button" disabled={disabled || translating || !canTranslate} onClick={onTranslate}>
        {translating ? "Translating…" : value.title || value.text ? "Translate again" : "Translate"}
      </button>
      {children}
      <label>
        Title
        <input
          value={value.title}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="标题"
        />
        <small className="publisher-count" data-over={titleLength > 20}>
          {titleLength} / 20
        </small>
      </label>
      <label>
        Text
        <textarea
          value={value.text}
          maxLength={5000}
          rows={5}
          disabled={disabled}
          onChange={(e) => set({ text: e.target.value })}
          placeholder="正文"
        />
        <small className="publisher-count" data-over={text.used > text.limit}>
          {text.used} / {text.limit}
        </small>
      </label>
      <label>
        Topics
        <input
          value={value.topics}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => set({ topics: e.target.value })}
          placeholder="#生活美学 #旅行"
        />
      </label>
    </fieldset>
  );
}
