/** Chrome/Edge Native Messaging framing only; no transport or side effects. */
import { Buffer } from "node:buffer";

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
export type NativeMessage = Record<string, unknown>;

export class NativeMessageFramingError extends Error {
  override get name(): string { return "NativeMessageFramingError"; }
}

function isMessage(value: unknown): value is NativeMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The cap applies to UTF-8 payload bytes, excluding the four-byte header. */
export function encodeNativeMessage(message: NativeMessage): Uint8Array {
  if (!isMessage(message)) throw new NativeMessageFramingError("Message must be a JSON object");
  let json: string;
  try {
    const encoded = JSON.stringify(message);
    if (encoded === undefined || !isMessage(JSON.parse(encoded)))
      throw new Error("Serialized message is not an object");
    json = encoded;
  } catch {
    throw new NativeMessageFramingError("Message cannot be serialized as a JSON object");
  }
  const length = Buffer.byteLength(json, "utf8");
  if (length > MAX_NATIVE_MESSAGE_BYTES)
    throw new NativeMessageFramingError("Message exceeds payload limit");
  const frame = new Uint8Array(4 + length);
  new DataView(frame.buffer).setUint32(0, length, true);
  new TextEncoder().encodeInto(json, frame.subarray(4));
  return frame;
}

/** Retains at most one capped payload plus a header. Input bytes are copied,
 * never retained by reference; fragmented input does not concatenate buffers.
 * A malformed frame poisons the decoder, including any later EOF call.
 */
export class NativeMessageDecoder {
  private readonly header = new Uint8Array(4);
  private headerBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;
  private failure: NativeMessageFramingError | null = null;
  private ended = false;

  push(chunk: Uint8Array): NativeMessage[] {
    if (this.failure) throw this.failure;
    if (this.ended) this.fail("Input after EOF");
    if (!(chunk instanceof Uint8Array)) this.fail("Input must be bytes");
    const messages: NativeMessage[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes !== 4) continue;
        const length = new DataView(this.header.buffer).getUint32(0, true);
        if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) this.fail("Invalid payload length");
        this.payload = new Uint8Array(length);
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes !== this.payload.length) continue;
      let value: unknown;
      try {
        // Preserve BOM so JSON.parse rejects it instead of silently stripping it.
        const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.payload);
        value = JSON.parse(json);
      } catch {
        this.fail("Invalid UTF-8 or JSON payload");
      }
      if (!isMessage(value)) this.fail("Message must be a JSON object");
      messages.push(value);
      this.payload = null;
      this.payloadBytes = 0;
      this.headerBytes = 0;
    }
    return messages;
  }

  /** Call at transport EOF; an incomplete header or payload is an error. */
  finish(): void {
    if (this.failure) throw this.failure;
    if (this.headerBytes !== 0 || this.payload !== null) this.fail("Partial frame at EOF");
    this.ended = true;
  }

  private fail(message: string): never {
    this.payload = null;
    this.payloadBytes = 0;
    this.headerBytes = 0;
    this.failure = new NativeMessageFramingError(message);
    throw this.failure;
  }
}
