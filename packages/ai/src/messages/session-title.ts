export const SESSION_TITLE_LIMIT = 10;

/** Count visible characters, not UTF-16 units or individual emoji components. */
export function limitSessionTitle(text: string): string {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text))
    .slice(0, SESSION_TITLE_LIMIT)
    .map((part) => part.segment)
    .join("");
}

export function shortSessionTitle(text: string): string {
  return limitSessionTitle(text.replace(/\s+/gu, " ").trim());
}