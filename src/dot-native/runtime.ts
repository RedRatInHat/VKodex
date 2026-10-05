import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeChat, BridgeInput, OwnerAccess } from "../bridge/contracts.js";
import { NativeDotMcpClient } from "./mcp-client.js";
import { DotRelayStore } from "./relay-store.js";
import { DotNativeRelay, type DotRelayHealth } from "./relay.js";

interface DotRuntimeConfig {
  readonly version: 1;
  readonly enabled: true;
  readonly peerId: number;
  readonly threadId: string;
  readonly callerThreadId: string;
  readonly callerHostId: "local" | "durable";
  readonly pluginRoot: string;
  readonly pipePath: string;
  /** Trusted cursor recorded when provisioning the dedicated chat. */
  readonly inboundAfterMessageId: number;
}
export function parseDotRuntimeConfig(value:unknown):DotRuntimeConfig {
  if(value===null || typeof value!=="object" || Array.isArray(value))throw new TypeError("Invalid dot route configuration");
  const v=value as Record<string,unknown>;
  const allowed=new Set(["version","enabled","peerId","threadId","callerThreadId","callerHostId","pluginRoot","pipePath","inboundAfterMessageId"]);
  if(Object.keys(v).some(key=>!allowed.has(key)) || v.version!==1 || v.enabled!==true ||
    !Number.isSafeInteger(v.inboundAfterMessageId) || (v.inboundAfterMessageId as number)<0 ||
    !Number.isSafeInteger(v.peerId) || (v.peerId as number)<2_000_000_000 ||
    !["local","durable"].includes(v.callerHostId as string) ||
    [v.threadId,v.callerThreadId,v.pluginRoot,v.pipePath].some(s=>typeof s!=="string" || !s || s.length>4096 || /[\x00-\x1f]/u.test(s)) ||
    v.threadId===v.callerThreadId || !path.isAbsolute(v.pluginRoot as string))throw new TypeError("Invalid dot route configuration");
  return v as unknown as DotRuntimeConfig;
}
/** Configuration is locally provisioned from the actual app task context.
 * No credentials are created or copied; no discovery scans, browser or UI automation.
 * Absent file means the existing bridge has exactly its original behavior.
 */
export async function loadDotNativeRoute(dataDir:string,access:OwnerAccess,chat:BridgeChat,
  occupiedPeer:(peerId:number)=>boolean,onHealth:(state:DotRelayHealth)=>void,
  recoverInput?:(peerId:number,after:number)=>Promise<{inputs:BridgeInput[];cursor:number}>):Promise<{relay:DotNativeRelay;close:()=>Promise<void>}|null> {
  let text:string;
  try {text=await readFile(path.join(dataDir,"dot-native.json"),"utf8");}
  catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  if(text.length>16_384)throw new Error("Dot route configuration is too large");
  const config=parseDotRuntimeConfig(JSON.parse(text));
  if(occupiedPeer(config.peerId))throw new Error("Dot requires a separate VK conversation");
  const store=new DotRelayStore(path.join(dataDir,"dot-native.sqlite"),{
    threadId:config.threadId,peerId:config.peerId,ownerId:access.ownerId,
  });
  store.initializeInboundCursor(config.inboundAfterMessageId);
  const relay=new DotNativeRelay(store,chat,()=>new NativeDotMcpClient({
    pluginRoot:config.pluginRoot,callerThreadId:config.callerThreadId,callerHostId:config.callerHostId,
    targetThreadId:config.threadId,pipePath:config.pipePath,
  }),onHealth,recoverInput);
  return {relay,close:async()=>{await relay.stop();store.close();}};
}
