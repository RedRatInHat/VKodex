import path from "node:path";
import { z } from "zod";
import type { ConversationMode, SessionMemberMode } from "./domain/models.js";

const optionalString = z.preprocess(
  (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalPositiveInteger = z.preprocess(
  (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const booleanFromEnv = z.preprocess((value: unknown) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  VK_GROUP_TOKEN: z.string().min(1),
  VK_GROUP_ID: z.coerce.number().int().positive(),
  VK_OWNER_IDS: z.string().min(1),
  VK_ALLOWED_USER_IDS: z.string().min(1),
  VK_MAIN_USER_IDS: optionalString,
  VK_MAIN_PEER_ID: optionalPositiveInteger,
  VK_CONVERSATION_MODE: z.enum(["managed", "single", "auto"]).default("auto"),
  VK_SESSION_MEMBER_MODE: z.enum(["requester", "main-users"]).default("requester"),
  WORKSPACE_ROOTS: z.string().min(1),
  BOT_DATA_DIR: z.string().default("./data"),
  OPENAI_API_KEY: optionalString,
  CODEX_MODEL: optionalString,
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_APPROVAL_POLICY: z
    .enum(["untrusted", "on-failure", "on-request", "never"])
    .default("never"),
  CODEX_SKIP_GIT_REPO_CHECK: booleanFromEnv.default(false),
  CODEX_ENV_ALLOWLIST: optionalString,
  MAX_INBOUND_FILES: z.coerce.number().int().positive().default(10),
  MAX_INBOUND_FILE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MAX_INBOUND_TOTAL_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  MAX_OUTBOUND_FILES: z.coerce.number().int().positive().default(10),
  MAX_OUTBOUND_FILE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MAX_OUTBOUND_TOTAL_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  VK_MESSAGE_CHUNK_SIZE: z.coerce.number().int().min(500).max(8_000).default(3_500),
  LOG_LEVEL: z.string().default("info"),
});

function parseIdList(raw: string, name: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));

  if (ids.length === 0 || ids.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive numeric VK IDs`);
  }

  return [...new Set(ids)];
}

function parseRoots(raw: string): string[] {
  const roots = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  if (roots.length === 0) throw new Error("WORKSPACE_ROOTS must contain at least one path");
  return [...new Set(roots)];
}

function parseEnvironmentAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  const names = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment variable name in CODEX_ENV_ALLOWLIST: ${name}`);
    }
  }

  return [...new Set(names)];
}

export interface AppConfig {
  readonly vk: {
    readonly token: string;
    readonly groupId: number;
    readonly ownerIds: ReadonlySet<number>;
    readonly allowedUserIds: ReadonlySet<number>;
    readonly mainUserIds: readonly number[];
    readonly configuredMainPeerId?: number;
    readonly conversationMode: ConversationMode;
    readonly sessionMemberMode: SessionMemberMode;
    readonly messageChunkSize: number;
  };
  readonly codex: {
    readonly apiKey?: string;
    readonly model?: string;
    readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    readonly approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
    readonly skipGitRepoCheck: boolean;
    readonly environmentAllowlist: readonly string[];
  };
  readonly files: {
    readonly maxInboundFiles: number;
    readonly maxInboundFileBytes: number;
    readonly maxInboundTotalBytes: number;
    readonly maxOutboundFiles: number;
    readonly maxOutboundFileBytes: number;
    readonly maxOutboundTotalBytes: number;
    readonly downloadTimeoutMs: number;
  };
  readonly workspaceRoots: readonly string[];
  readonly dataDir: string;
  readonly logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const ownerIds = parseIdList(parsed.VK_OWNER_IDS, "VK_OWNER_IDS");
  const allowedIds = parseIdList(parsed.VK_ALLOWED_USER_IDS, "VK_ALLOWED_USER_IDS");
  const mainUserIds = parsed.VK_MAIN_USER_IDS
    ? parseIdList(parsed.VK_MAIN_USER_IDS, "VK_MAIN_USER_IDS")
    : ownerIds;

  for (const ownerId of ownerIds) {
    if (!allowedIds.includes(ownerId)) {
      throw new Error(`Owner VK ID ${ownerId} must also be present in VK_ALLOWED_USER_IDS`);
    }
  }

  for (const mainUserId of mainUserIds) {
    if (!allowedIds.includes(mainUserId)) {
      throw new Error(`Main-chat VK ID ${mainUserId} must also be present in VK_ALLOWED_USER_IDS`);
    }
  }

  if (parsed.CODEX_SANDBOX_MODE === "danger-full-access") {
    throw new Error(
      "CODEX_SANDBOX_MODE=danger-full-access is intentionally blocked in the VK bridge. Change the code only after a security review.",
    );
  }

  return {
    vk: {
      token: parsed.VK_GROUP_TOKEN,
      groupId: parsed.VK_GROUP_ID,
      ownerIds: new Set(ownerIds),
      allowedUserIds: new Set(allowedIds),
      mainUserIds,
      ...(parsed.VK_MAIN_PEER_ID === undefined
        ? {}
        : { configuredMainPeerId: parsed.VK_MAIN_PEER_ID }),
      conversationMode: parsed.VK_CONVERSATION_MODE,
      sessionMemberMode: parsed.VK_SESSION_MEMBER_MODE,
      messageChunkSize: parsed.VK_MESSAGE_CHUNK_SIZE,
    },
    codex: {
      ...(parsed.OPENAI_API_KEY === undefined ? {} : { apiKey: parsed.OPENAI_API_KEY }),
      ...(parsed.CODEX_MODEL === undefined ? {} : { model: parsed.CODEX_MODEL }),
      sandboxMode: parsed.CODEX_SANDBOX_MODE,
      approvalPolicy: parsed.CODEX_APPROVAL_POLICY,
      skipGitRepoCheck: parsed.CODEX_SKIP_GIT_REPO_CHECK,
      environmentAllowlist: parseEnvironmentAllowlist(parsed.CODEX_ENV_ALLOWLIST),
    },
    files: {
      maxInboundFiles: parsed.MAX_INBOUND_FILES,
      maxInboundFileBytes: parsed.MAX_INBOUND_FILE_BYTES,
      maxInboundTotalBytes: parsed.MAX_INBOUND_TOTAL_BYTES,
      maxOutboundFiles: parsed.MAX_OUTBOUND_FILES,
      maxOutboundFileBytes: parsed.MAX_OUTBOUND_FILE_BYTES,
      maxOutboundTotalBytes: parsed.MAX_OUTBOUND_TOTAL_BYTES,
      downloadTimeoutMs: parsed.DOWNLOAD_TIMEOUT_MS,
    },
    workspaceRoots: parseRoots(parsed.WORKSPACE_ROOTS),
    dataDir: path.resolve(parsed.BOT_DATA_DIR),
    logLevel: parsed.LOG_LEVEL,
  };
}
