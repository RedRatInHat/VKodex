import { createHash } from "node:crypto";
import path from "node:path";

/** Candidate ID for a keyless unpacked extension on Windows, following Chromium
 * GenerateIdForPath/MaybeNormalizePath. Use the exact installed path spelling;
 * only the drive letter is uppercased. This is NOT proof of installation or
 * browser identity: the native channel must still enforce allowed_origins.
 * https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc
 */
export function windowsUnpackedExtensionId(directory: string): string {
  if (!/^[a-z]:\\/iu.test(directory) || /[\x00-\x1f\x7f]/u.test(directory) ||
      directory.includes("/") || path.win32.normalize(directory) !== directory || directory.endsWith("\\"))
    throw new Error("Exact absolute Windows extension path required");
  const normalized = directory[0]!.toUpperCase() + directory.slice(1);
  const hex = createHash("sha256").update(Buffer.from(normalized, "utf16le")).digest("hex").slice(0, 32);
  return [...hex].map(character => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
}
