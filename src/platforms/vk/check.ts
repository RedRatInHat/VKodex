import { VK } from "vk-io";
import { loadDesktopBridgeConfig } from "../../bridge/config.js";
import { checkVkReadiness } from "./readiness.js";

async function main(): Promise<void> {
  let config;
  try { config = loadDesktopBridgeConfig(); }
  catch {
    process.stderr.write("Заполни VK_GROUP_TOKEN, VK_GROUP_ID и один VK_OWNER_ID в локальной .env. Значения в вывод не попадают.\n");
    process.exitCode = 1;
    return;
  }
  const vk = new VK({ token: config.token, apiVersion: "5.199", apiRetryLimit: 0 });
  const checks = await checkVkReadiness({
    tokenPermissions: () => vk.api.groups.getTokenPermissions({}),
    longPollSettings: () => vk.api.groups.getLongPollSettings({ group_id: config.access.groupId }),
    longPollServer: () => vk.api.groups.getLongPollServer({ group_id: config.access.groupId }),
  });
  for (const check of checks) process.stdout.write(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}\n`);
  process.stdout.write("Проверка только читает настройки VK. Беседы и сообщения не создавались; Codex не подключался.\n");
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}

await main().catch(() => {
  process.stderr.write("Проверка VK не завершилась. Содержимое ошибки скрыто, чтобы не раскрыть учётные данные.\n");
  process.exitCode = 1;
});
