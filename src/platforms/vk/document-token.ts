import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

/**
 * Read the user token from a DPAPI-protected file without putting it in an
 * environment variable, command line, log, or repository file.
 */
export async function readProtectedVkToken(filePath: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("DPAPI-хранилище VK-документов доступно только в Windows.");
  const candidates = [
    path.resolve(process.cwd(), "scripts", "read-vk-document-token.ps1"),
    fileURLToPath(new URL("../../../scripts/read-vk-document-token.ps1", import.meta.url)),
    fileURLToPath(new URL("../../../../scripts/read-vk-document-token.ps1", import.meta.url)),
  ];
  const script = candidates.find(candidate => existsSync(candidate));
  if (!script) throw new Error("VK token helper is not installed.");
  try {
    const result = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Path", path.resolve(filePath),
    ], { windowsHide: true, maxBuffer: 16 * 1024 });
    const token = result.stdout.trim();
    if (!token || /[\r\n]/u.test(token)) throw new Error("Локальное хранилище VK-токена пусто или повреждено.");
    return token;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Локальное хранилище VK-токена")) throw error;
    throw new Error("Не удалось прочитать локальный VK-токен. Запусти npm run vk:token:setup на компьютере VKodex.");
  }
}
