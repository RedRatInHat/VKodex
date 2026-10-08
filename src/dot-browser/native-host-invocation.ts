import path from "node:path";

export interface DotNativeHostInvocation {
  readonly configPath: string;
  readonly extensionId: string;
  readonly origin: string;
}

/** The launcher's pinned expected ID is not inferred from the caller's origin.
 * Chrome/Edge additionally enforces the installed allowed_origins manifest.
 * This is a local same-user boundary, not authentication against malicious
 * processes already running as the owner.
 */
export function parseDotNativeHostInvocation(args: readonly string[]): DotNativeHostInvocation {
  if (args.length < 5 || args.length > 6 || args[0] !== "--config" || args[2] !== "--extension-id")
    throw new Error("Invalid native host invocation");
  const configPath = args[1]!, extensionId = args[3]!, origin = args[4]!;
  if (!path.isAbsolute(configPath) || /^(?:\\\\|\/\/)/u.test(configPath) || /[\x00-\x1f\x7f]/u.test(configPath) || !/^[a-p]{32}$/u.test(extensionId) ||
      origin !== `chrome-extension://${extensionId}/` ||
      args.length === 6 && !/^--parent-window=\d{1,20}$/u.test(args[5]!))
    throw new Error("Invalid native host invocation");
  return { configPath, extensionId, origin };
}
