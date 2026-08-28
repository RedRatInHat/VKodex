export function chunkText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxLength) return [normalized];

  const result: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const splitAt = candidates.find((index) => index >= Math.floor(maxLength * 0.55)) ?? maxLength;
    const chunk = remaining.slice(0, splitAt).trimEnd();
    result.push(chunk || remaining.slice(0, maxLength));
    remaining = remaining.slice(chunk.length || maxLength).trimStart();
  }

  if (remaining.length > 0) result.push(remaining);
  return result;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
