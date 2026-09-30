/** Return only completed, readable clauses from a streamed answer. */
export function readablePreview(text: string): string {
  const source = text.replaceAll("\r", "").trimStart();
  const lineEnd = source.lastIndexOf("\n");
  if (lineEnd >= 0) {
    const complete = source.slice(0, lineEnd).trim();
    if (complete.length >= 10) return complete;
  }
  let sentenceEnd = -1;
  for (const mark of ["。", "！", "？", "；"]) sentenceEnd = Math.max(sentenceEnd, source.lastIndexOf(mark));
  if (sentenceEnd >= 9) return source.slice(0, sentenceEnd + 1).trim();
  return "";
}
