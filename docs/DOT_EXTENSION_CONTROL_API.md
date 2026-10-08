# Dot extension control API

Status: experimental core and fixture tests. No host registration, extension
permission change, MCP registration or live browser submission is installed.

The owner selected existing Edge authentication and requested automatic control
and logs instead of manually coordinating a popup, message, timer and screenshot.
The previous one-shot test became uncertain after about 23.6 seconds. Posting
the armed-status report into the observed chat is consistent with interference;
the old receipt lacked a reason, so the historical cause is not proven.

## Composition

- `control-protocol.ts`: strict status, result and observe-and-submit envelopes.
  Requests and replies bind room, generation, connection epoch, request ID and
  operation ID. No arbitrary JavaScript, selectors, URLs or credential arguments.
- `control-service.ts`: receive into the existing `DotRoomInputJournal`, check
  connection admission, commit its durable dispatch fence, then call one combined
  observe-and-submit transport operation. Deadline or invalid/missing receipt
  retains uncertainty; neither replay nor text-match recovery is allowed.
- `input-journal.ts`: operation-ID index and read-only saved result lookup, with
  no prompt text in results. Recovery from the shared inbox remains authoritative.
- `native-control-peer.ts`: one pending request over already authenticated streams.
  Native command acknowledgement does not settle submission; only a correctly
  bound terminal receipt can do so. Abort/EOF/protocol failure closes the peer.
- `native-message-framing.ts`: bounded incremental UTF-8 JSON framing, defensive
  copies, strict object root, 1 MiB application cap and permanent decoder failure.
- `control-diagnostics.ts`: existing shared sanitized diagnostic sink, run/PID,
  sequence, timestamp, request/operation/connection correlation and stage duration.
  No prompts, replies, raw errors, credentials or browser storage enter logs.
- The observer supplies bounded terminal reasons. The popup is optional diagnostic
  display, not the source of truth for the new host control interface.

## Runtime work still required

An extension worker must own one port, validate its pinned room configuration,
locate the qualified tab and perform observation plus ordinary composer submission
as one command. It must refuse a pre-existing draft, wrong room/account UI,
unqualified controls, duplicate operations and concurrent user interference.
It must report armed/dispatch/receipt stages automatically. A disconnect after a
send cannot be converted to not-sent, and late success cannot release recovered
uncertainty automatically.

The Native Messaging host must validate the configured extension origin and
establish the local authenticated bridge endpoint. The currently implemented peer
accepts streams; it does not authenticate or register a host. The CLI/MCP surface
must wrap the same service, not start a second VK consumer or maintain a second
input queue. Operational results live in the durable store; diagnostic logs do
not authorize actions or retries.

Installation requires a reviewed manifest, bounded ChatGPT host access and
Native Messaging permission, a host manifest restricted to the installed extension
ID, approved registration and rollback. Do not install these under the earlier
diagnostic activeTab-only permission. Do not expose an unauthenticated localhost
command server or impersonate a first-party application plugin.

Edge's documented channel uses stdin/stdout JSON messages with a length prefix
and an allowed-extension host manifest. Our cap is stricter on inbound messages
than the browser's maximum. Source: [Microsoft Native Messaging documentation](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging).

## Qualification

Automated fixtures cover framing, wrong-scope replies, acknowledgement versus
acceptance, duplicate/concurrent requests, disconnect, timeout/late result,
durable operation lookup and log redaction. These are not live UI evidence.
Before activation, run one automatically coordinated marked canary, save its
structured result, independently verify the exact visible message identity, and
test reconnect without replay. Never ask the user to post an armed-status report
between starting the observer and submitting the canary.
