const KANA = /[぀-ヿ]/;
const HAN = /[㐀-䶿一-鿿]/;

/**
 * Tags text with the language its glyphs belong to, so Han characters pick the
 * right face: kana anywhere means Japanese, Han on its own means Chinese.
 */
export function langFor(text: string) {
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh-Hant";
  return undefined;
}
