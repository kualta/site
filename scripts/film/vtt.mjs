// A clip's words (`<clip>.vtt` beside it, and its translations, `<clip>.<language>.vtt`) are in the file's own
// seconds, so a trim of the clip needs them moved to its seconds: every cue and word time moved by the same amount,
// cues wholly outside the trim dropped and the rest kept inside it. Everything but the times stays as it was, the
// note at the top of a transcript cut by hand in Studio included.

const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
const CUE_TIMES = new RegExp(`^(\\s*)(${STAMP.source})(\\s+-->\\s+)(${STAMP.source})(.*)$`);
const WORD = new RegExp(`<(${STAMP.source})>`, "g");

const msOf = (stamp) => {
  const [, h, m, s, ms] = STAMP.exec(stamp);
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
};
const stampOf = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const two = (n) => String(n).padStart(2, "0");
  return `${two(Math.floor(t / 3_600_000))}:${two(Math.floor(t / 60_000) % 60)}:${two(
    Math.floor(t / 1000) % 60,
  )}.${String(t % 1000).padStart(3, "0")}`;
};

/**
 * `text` (a WebVTT file) with every time moved by `moveMs`, for a file `lengthMs` long: a cue that ends at or before
 * its start or begins at or after its end is left out, and the rest are held inside it, their words too.
 */
export function moveVtt(text, moveMs, lengthMs = Number.POSITIVE_INFINITY) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /(?:\r?\n)*$/.exec(text)[0];
  const blocks = text.slice(0, text.length - trailing.length).split(/\r?\n(?:[ \t]*\r?\n)+/);
  const kept = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((line) => CUE_TIMES.test(line));
    if (at === -1 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) {
      kept.push(block);
      continue;
    }
    const [, lead, start, , , , , arrow, end, , , , , settings] = CUE_TIMES.exec(lines[at]);
    const from = msOf(start) + moveMs;
    const to = msOf(end) + moveMs;
    if (to <= 0 || from >= lengthMs) continue;
    const a = Math.max(0, from);
    const b = Math.min(lengthMs, to);
    lines[at] = `${lead}${stampOf(a)}${arrow}${stampOf(b)}${settings}`;
    for (let i = at + 1; i < lines.length; i++)
      lines[i] = lines[i].replace(WORD, (_, stamp) => `<${stampOf(Math.min(b, Math.max(a, msOf(stamp) + moveMs)))}>`);
    kept.push(lines.join(eol));
  }
  return kept.join(eol + eol) + trailing;
}
