const latin = /\p{Script=Latin}/u;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const latinPhrase = /\p{Script=Latin}[\s’'-]+\p{Script=Latin}/u;
const cjkPhrase = /(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}].*?){3}/u;

export interface DisplayLyricLine extends LyricLine {
  translationWords?: LyricWord[];
}

export function translationSuffix(text: string, translation?: string) {
  return translation && !text.trimEnd().endsWith(translation) ? "\u3000" + translation : "";
}

function wordsInRange(words: LyricWord[], start: number, end: number) {
  const result: LyricWord[] = [];
  let pos = 0;
  for (const word of words) {
    const next = pos + word.text.length;
    if (next > start && pos < end) {
      const text = word.text.slice(Math.max(0, start - pos), end - pos);
      if (text) result.push(text === word.text ? word : { ...word, text });
    }
    pos = next;
    if (pos >= end) break;
  }
  return result;
}

/** Use the provider's translation first. Only infer a boundary between two distinct script runs. */
export function displayLyricLine(line: LyricLine, split: boolean): DisplayLyricLine {
  if (!split || (line.translation && !line.text.trimEnd().endsWith(line.translation))) return line;
  const text = line.text;
  const firstLatin = text.search(latin);
  const firstCjk = text.search(cjk);
  if (firstLatin < 0 || firstCjk < 0) return line;
  const latinFirst = firstLatin < firstCjk;
  const boundary = Math.max(firstLatin, firstCjk);
  if ((latinFirst ? latin : cjk).test(text.slice(boundary))) return line;

  const before = text.slice(0, boundary);
  // Keep opening punctuation with the second phrase and drop an explicit field separator.
  const opening = /[（(【「『“‘[]\s*$/u.exec(before);
  const translationStart = opening?.index ?? boundary;
  const prefix = before.slice(0, translationStart).trimEnd();
  const divider = /(?:[|｜/／]+|[ \t][—–-])$/u.exec(prefix);
  const original = prefix.slice(0, divider?.index ?? prefix.length).trimEnd();
  const translation = text.slice(translationStart).trimEnd();
  if (line.translation && line.translation !== translation) return line;
  if (!line.translation && !opening && !divider && !before.includes("\n")) {
    if (!latinPhrase.test(latinFirst ? original : translation) || !cjkPhrase.test(latinFirst ? translation : original))
      return line;
  }
  return {
    ...line,
    text: original,
    translation,
    ...(line.words && {
      words: wordsInRange(line.words, 0, original.length),
      translationWords: wordsInRange(line.words, translationStart, translationStart + translation.length),
    }),
  };
}

export function firstPlainLyric(plain: string, translation: string, romanization: string): LyricLine {
  const [text, next] = plain.split("\n", 2);
  let companion = translation.split("\n", 1)[0];
  if (
    !companion &&
    next &&
    ((latin.test(text) && !cjk.test(text) && cjk.test(next) && !latin.test(next)) ||
      (cjk.test(text) && !latin.test(text) && latin.test(next) && !cjk.test(next)))
  )
    companion = next;
  return { time: 0, text, translation: companion, romanization: romanization.split("\n", 1)[0] };
}

/** Untimed lyrics keep their existing line breaks, including stanza breaks. */
export function plainLyricText(plain: string, split: boolean) {
  if (!split || !latin.test(plain) || !cjk.test(plain)) return plain;
  return plain
    .split("\n")
    .map(text => {
      const line = displayLyricLine({ time: 0, text }, true);
      return line.translation ? line.text + "\n" + line.translation : text;
    })
    .join("\n");
}
