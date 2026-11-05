export function citationParts(text: string): { text: string; id?: string }[] {
  const result: { text: string; id?: string }[] = [];
  const pattern = /\[kb:(chk_[0-9A-HJKMNP-TV-Z]{26})\]/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) result.push({ text: text.slice(start, match.index) });
    result.push({ text: match[0], id: match[1]! });
    start = match.index + match[0].length;
  }
  if (start < text.length) result.push({ text: text.slice(start) });
  return result;
}
