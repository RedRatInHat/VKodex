import { isObject } from "../../desktop/ipc-client.js";

export interface VkReadinessApi {
  tokenPermissions(): Promise<unknown>;
  longPollSettings(): Promise<unknown>;
  longPollServer(): Promise<unknown>;
}

export interface ReadinessCheck {
  readonly name: "messages_permission" | "long_poll" | "message_new" | "message_event" | "event_version" | "long_poll_server";
  readonly ok: boolean;
  readonly detail: string;
}

function enabled(value: unknown): boolean { return value === true || value === 1; }

function failureDetail(error: unknown): string {
  // API exceptions can contain request parameters, including credentials.
  // Only a numeric error code is allowed into diagnostics output.
  const code = isObject(error) && typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
  return code === undefined ? "Нет корректного ответа VK; проверь сеть и настройки." : `VK отклонил запрос (код ${code}).`;
}

export async function checkVkReadiness(api: VkReadinessApi): Promise<readonly ReadinessCheck[]> {
  const result: ReadinessCheck[] = [];
  try {
    const response = await api.tokenPermissions();
    const permissions = isObject(response) && Array.isArray(response.permissions) ? response.permissions : [];
    const ok = permissions.some(item => isObject(item) && item.name === "messages" && typeof item.setting === "number" && item.setting > 0);
    result.push({ name: "messages_permission", ok, detail: ok ? "Ключ сообщества имеет доступ к сообщениям." : "Нужен ключ сообщества с разрешением на сообщения." });
  } catch (error) { result.push({ name: "messages_permission", ok: false, detail: failureDetail(error) }); }

  try {
    const response = await api.longPollSettings();
    const settings = isObject(response) ? response : {};
    const events = isObject(settings.events) ? settings.events : {};
    result.push({ name: "long_poll", ok: enabled(settings.is_enabled), detail: enabled(settings.is_enabled) ? "Bots Long Poll включён." : "Включи Bots Long Poll в настройках сообщества." });
    for (const name of ["message_new", "message_event"] as const) {
      result.push({ name, ok: enabled(events[name]), detail: enabled(events[name]) ? `Событие ${name} включено.` : `Включи событие ${name} в типах событий Long Poll.` });
    }
    const compatible = settings.api_version === "5.199";
    result.push({ name: "event_version", ok: compatible, detail: compatible ? "Версия событий соответствует адаптеру: 5.199." : "В настройках Long Poll нужна версия 5.199. Другие версии ещё не проверены." });
  } catch (error) { result.push({ name: "long_poll", ok: false, detail: failureDetail(error) }); }

  try {
    const response = await api.longPollServer();
    const ok = isObject(response) && typeof response.key === "string" && response.key.length > 0 && typeof response.server === "string" && response.server.length > 0 && (typeof response.ts === "string" || typeof response.ts === "number");
    result.push({ name: "long_poll_server", ok, detail: ok ? "Доступ к Long Poll указанного сообщества подтверждён." : "VK не вернул полные параметры Long Poll." });
  } catch (error) { result.push({ name: "long_poll_server", ok: false, detail: failureDetail(error) }); }
  return result;
}
