import type { View } from "./contracts.js";

/** Bound only the read-only manager dashboard, never prompts or confirmations. */
export const VK_INTERACTIVE_TEXT_BUDGET = 4_000;
const shortened = "\n\n… Карточка сокращена из-за ограничения VK; кнопки доступны.";

export function boundedInteractiveView(view: View): View {
  if (!view.buttons || !view.text.startsWith("VKodex · менеджер\n") || view.text.length <= VK_INTERACTIVE_TEXT_BUDGET) return view;
  let end = VK_INTERACTIVE_TEXT_BUDGET - shortened.length;
  // UTF-16 slicing must not leave half of an emoji before the notice.
  if (/[\uD800-\uDBFF]/u.test(view.text[end - 1]!)) end--;
  return { ...view, text: view.text.slice(0, end).trimEnd() + shortened };
}
