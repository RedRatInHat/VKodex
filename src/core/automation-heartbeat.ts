const HEARTBEAT = /<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>/gu;

function field(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "u").exec(body);
  return match?.[1]?.trim() || null;
}

/** Scheduler prompts are implementation messages, not user-authored chat. */
export function isAutomationHeartbeatInput(text: string): boolean {
  const trimmed = text.trim();
  const match = /^<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>$/u.exec(trimmed);
  if (!match) return false;
  const body = match[1] ?? "";
  return field(body, "automation_id") !== null
    && field(body, "current_time_iso") !== null
    && field(body, "instructions") !== null
    && field(body, "decision") === null;
}

/**
 * Converts the scheduler's private XML response contract into visible chat.
 * Unknown or malformed envelopes are preserved so a parser change cannot
 * silently discard a real answer.
 */
export function visibleAutomationHeartbeatOutput(text: string): string | null {
  const matches = [...text.matchAll(HEARTBEAT)];
  if (!matches.length) return text;

  const parsed = matches.map(match => {
    const body = match[1] ?? "";
    const automationId = field(body, "automation_id");
    const decision = field(body, "decision");
    const message = field(body, "message");
    return { match, automationId, decision, message };
  });
  if (parsed.some(item => !item.automationId || !item.message || !["NOTIFY", "DONT_NOTIFY"].includes(item.decision ?? ""))) {
    return text;
  }

  // DONT_NOTIFY is authoritative even if a model accidentally emitted prose
  // next to the envelope: the automation explicitly chose a quiet result.
  if (parsed.some(item => item.decision === "DONT_NOTIFY")) return null;

  let outside = text;
  for (const item of [...parsed].reverse()) {
    const index = item.match.index ?? 0;
    outside = outside.slice(0, index) + outside.slice(index + item.match[0].length);
  }
  outside = outside.trim();
  if (outside) return outside;
  return parsed.map(item => item.message).join("\n\n");
}
