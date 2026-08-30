import { isObject, type IpcObject } from "./ipc-client.js";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function pathParts(value: unknown): (string | number)[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid patch path");
  return value.map((part: unknown) => {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) return part;
    if (typeof part === "string" && !UNSAFE_KEYS.has(part)) return part;
    throw new Error("Unsafe patch path");
  });
}

function mutate(root: IpcObject, patch: IpcObject): IpcObject {
  const parts = pathParts(patch.path);
  if (!["add", "replace", "remove"].includes(String(patch.op))) throw new Error("Invalid patch operation");
  if (parts.length === 0) {
    if (patch.op === "remove" || !isObject(patch.value)) throw new Error("Invalid root patch");
    return structuredClone(patch.value);
  }
  let parent: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if ((!isObject(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, part)) throw new Error("Missing patch parent");
    parent = (parent as IpcObject)[part];
  }
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (last === "length" && patch.op === "replace" && Number.isSafeInteger(patch.value) && (patch.value as number) >= 0 && (patch.value as number) <= parent.length) {
      parent.length = patch.value as number;
      return root;
    }
    if (typeof last !== "number" || last > parent.length || (patch.op !== "add" && last === parent.length)) throw new Error("Invalid array patch");
    if (patch.op === "add") parent.splice(last, 0, structuredClone(patch.value));
    else if (patch.op === "remove") parent.splice(last, 1);
    else parent[last] = structuredClone(patch.value);
  } else if (isObject(parent)) {
    if (patch.op !== "add" && !Object.hasOwn(parent, last)) throw new Error("Missing patch key");
    if (patch.op === "remove") delete parent[last];
    else parent[last] = structuredClone(patch.value);
  } else throw new Error("Invalid patch parent");
  return root;
}

export class RevisionedState {
  private revision: number | null = null;
  private state: IpcObject | null = null;

  get current(): IpcObject | null { return this.state; }
  get currentRevision(): number | null { return this.revision; }

  reset(): void { this.revision = null; this.state = null; }

  accept(change: unknown, validate: (state: IpcObject) => void = () => {}): IpcObject {
    if (!isObject(change) || !Number.isSafeInteger(change.revision) || (change.revision as number) < 0) throw new Error("Invalid state revision");
    let next: IpcObject;
    if (change.type === "snapshot" && isObject(change.conversationState)) {
      next = structuredClone(change.conversationState);
    } else if (change.type === "patches" && this.state && change.baseRevision === this.revision && (change.revision as number) > this.revision! && Array.isArray(change.patches)) {
      // Apply atomically: malformed or missing patches must never corrupt the last good state.
      next = structuredClone(this.state);
      for (const patch of change.patches) {
        if (!isObject(patch)) throw new Error("Invalid patch");
        next = mutate(next, patch);
      }
    } else throw new Error("State revision gap or incompatible snapshot");
    // Identity checks are part of the same transaction. A snapshot from a
    // different task copy must never replace the last verified state.
    validate(next);
    this.state = next;
    this.revision = change.revision as number;
    return this.state;
  }
}
