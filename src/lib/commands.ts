export interface NewCommand {
  readonly workspace: string;
  readonly title?: string;
}

export function parseNewCommand(text: string): NewCommand | null {
  const match = text.trim().match(/^\/new(?:\s+(.+))?$/iu);
  if (!match) return null;
  const body = match[1]?.trim();
  if (!body) return { workspace: "" };

  const separator = body.indexOf("|");
  if (separator < 0) return { workspace: body };

  const workspace = body.slice(0, separator).trim();
  const title = body.slice(separator + 1).trim();
  return title ? { workspace, title } : { workspace };
}

export function commandName(text: string): string | null {
  const match = text.trim().match(/^\/([a-zа-я_-]+)(?:\s|$)/iu);
  return match?.[1]?.toLowerCase() ?? null;
}

export function commandArgument(text: string): string {
  return text.trim().replace(/^\/[a-zа-я_-]+\s*/iu, "").trim();
}
