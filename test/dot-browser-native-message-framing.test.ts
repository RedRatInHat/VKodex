import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeNativeMessage, MAX_NATIVE_MESSAGE_BYTES, NativeMessageDecoder,
  NativeMessageFramingError, type NativeMessage,
} from "../src/dot-browser/native-message-framing.js";

function frame(payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const result = new Uint8Array(bytes.length + 4);
  new DataView(result.buffer).setUint32(0, bytes.length, true);
  result.set(bytes, 4);
  return result;
}

function rejectsPermanently(bytes: Uint8Array): void {
  const decoder = new NativeMessageDecoder();
  let failure: unknown;
  assert.throws(() => decoder.push(bytes), error => {
    failure = error;
    return error instanceof NativeMessageFramingError;
  });
  assert.throws(() => decoder.push(encodeNativeMessage({ valid: true })), error => error === failure);
  assert.throws(() => decoder.push(new Uint8Array()), error => error === failure);
  assert.throws(() => decoder.finish(), error => error === failure);
}

test("native frames round-trip non-ASCII with a little-endian byte length", () => {
  const message = { text: "Привет 🐈", nested: { list: [null, 1, true] } };
  const bytes = encodeNativeMessage(message);
  const length = new TextEncoder().encode(JSON.stringify(message)).length;
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), length);
  assert.deepEqual([...bytes.subarray(0, 4)], [length, 0, 0, 0]);
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(bytes), [message]);
  decoder.finish();
});

test("every single split position, including UTF-8 and header splits, decodes", () => {
  const message = { text: "😀ёж" };
  const bytes = encodeNativeMessage(message);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new NativeMessageDecoder();
    const received = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    assert.deepEqual(received, [message]);
    decoder.finish();
  }
});

test("byte-at-a-time input and coalesced frames preserve order", () => {
  const expected = [{ sequence: 1 }, { text: "é" }, {}];
  const bytes = Buffer.concat(expected.map(message => encodeNativeMessage(message)));
  const fragmented = new NativeMessageDecoder();
  const received: NativeMessage[] = [];
  for (const byte of bytes) received.push(...fragmented.push(Uint8Array.of(byte)));
  assert.deepEqual(received, expected);
  fragmented.finish();
  const coalesced = new NativeMessageDecoder();
  assert.deepEqual(coalesced.push(bytes), expected);
  coalesced.finish();
});

test("partial header and payload do not retain caller buffers", () => {
  const message = { text: "retained" };
  const bytes = encodeNativeMessage(message);
  const decoder = new NativeMessageDecoder();
  const header = bytes.slice(0, 2);
  assert.deepEqual(decoder.push(header), []);
  header.fill(255);
  const payload = bytes.slice(2, -1);
  assert.deepEqual(decoder.push(payload), []);
  payload.fill(255);
  assert.deepEqual(decoder.push(bytes.subarray(-1)), [message]);
  decoder.finish();
});

test("zero, oversize and unsigned maximum headers reject permanently", () => {
  for (const size of [0, MAX_NATIVE_MESSAGE_BYTES + 1, 0xffffffff]) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, size, true);
    rejectsPermanently(header);
  }
});

test("invalid JSON and non-object JSON roots reject permanently", () => {
  for (const json of ["{", "{}{}", "", "[]", "null", "true", "1", '"text"'])
    rejectsPermanently(frame(json));
});

test("invalid UTF-8 and a BOM are not silently normalized", () => {
  for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xff]])
    rejectsPermanently(frame(Uint8Array.from([123, 34, 120, 34, 58, 34, ...invalid, 34, 125])));
  rejectsPermanently(frame(Uint8Array.from([0xef, 0xbb, 0xbf, 123, 125])));
});

test("EOF rejects every partial header/payload and remains failed", () => {
  const bytes = encodeNativeMessage({ text: "unfinished" });
  for (let count = 1; count < bytes.length; count++) {
    const decoder = new NativeMessageDecoder();
    decoder.push(bytes.subarray(0, count));
    assert.throws(() => decoder.finish(), /Partial frame at EOF/u);
    assert.throws(() => decoder.push(bytes.subarray(count)), /Partial frame at EOF/u);
  }
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(new Uint8Array()), []);
  decoder.finish();
  decoder.finish();
  assert.throws(() => decoder.push(new Uint8Array()), /Input after EOF/u);
});

test("a valid frame followed by a partial frame rejects at EOF", () => {
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([encodeNativeMessage({ ok: true }), Uint8Array.of(2)])), [{ ok: true }]);
  assert.throws(() => decoder.finish(), /Partial frame at EOF/u);
});

test("actual payload boundaries count bytes and accept exactly one MiB", () => {
  const overhead = new TextEncoder().encode(JSON.stringify({ text: "" })).length;
  for (const size of [MAX_NATIVE_MESSAGE_BYTES - 1, MAX_NATIVE_MESSAGE_BYTES]) {
    const message = { text: "x".repeat(size - overhead) };
    const bytes = encodeNativeMessage(message);
    assert.equal(bytes.length, size + 4);
    const decoder = new NativeMessageDecoder();
    assert.deepEqual(decoder.push(bytes.subarray(0, 100)), []);
    assert.deepEqual(decoder.push(bytes.subarray(100)), [message]);
    decoder.finish();
  }
  assert.throws(() => encodeNativeMessage({ text: "x".repeat(MAX_NATIVE_MESSAGE_BYTES + 1 - overhead) }), /payload limit/u);
  assert.throws(() => encodeNativeMessage({ text: "é".repeat(Math.floor((MAX_NATIVE_MESSAGE_BYTES - overhead) / 2) + 1) }), /payload limit/u);
});

test("one-byte fragmentation at the maximum boundary completes without buffer concatenation", () => {
  const message = { text: "x".repeat(MAX_NATIVE_MESSAGE_BYTES - 11) };
  const bytes = encodeNativeMessage(message);
  assert.equal(bytes.length, MAX_NATIVE_MESSAGE_BYTES + 4);
  const decoder = new NativeMessageDecoder();
  const view = new Uint8Array(1);
  for (let index = 0; index < bytes.length - 1; index++) {
    view[0] = bytes[index]!;
    assert.equal(decoder.push(view).length, 0);
  }
  view[0] = bytes.at(-1)!;
  assert.deepEqual(decoder.push(view), [message]);
  decoder.finish();
});

test("encoder rejects invalid roots, serialization failures and non-object toJSON", () => {
  for (const value of [null, [], 3, "text", true, undefined, { toJSON: () => null }, { toJSON: () => [] }, { x: 1n }])
    assert.throws(() => encodeNativeMessage(value as NativeMessage), NativeMessageFramingError);
  const cycle: NativeMessage = {};
  cycle.self = cycle;
  assert.throws(() => encodeNativeMessage(cycle), NativeMessageFramingError);
});
