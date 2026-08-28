const DEFAULT_CODEX_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

const BRIDGE_SECRET_KEYS = new Set([
  "VK_GROUP_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
]);

/**
 * Builds the exact environment inherited by the Codex CLI subprocess.
 *
 * The SDK inherits all of process.env when `env` is omitted, so this bridge
 * deliberately uses a small baseline plus an explicit operator allowlist.
 * The SDK injects CODEX_API_KEY itself when `apiKey` is configured.
 */
export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv,
  extraAllowlist: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set<string>([...DEFAULT_CODEX_ENVIRONMENT_KEYS, ...extraAllowlist]);
  const result: Record<string, string> = {};

  for (const key of allowed) {
    if (BRIDGE_SECRET_KEYS.has(key) || key.startsWith("VK_")) continue;
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }

  return result;
}
