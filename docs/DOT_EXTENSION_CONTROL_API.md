# Dot extension control API

Status: experimental core and fixture tests. No host registration, extension
permission change, MCP registration or live browser submission is installed.

The source now also contains the atomic DOM submission adapter, per-port
extension controller and a separately built Chromium extension package.
They have not been installed or qualified against the live page. A diagnostic
native host/CLI bootstrap is implemented; scoped installation and live
qualification remain separate work.

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

The implemented worker accepts one native request at a time, including while
tab lookup is asynchronous. It qualifies a single exact target tab, rejects
ambiguous tabs and emits bounded injection/connection/response failures. It
reconnects the native host on a one-minute browser alarm without replaying
operations. It does not launch Edge, open a tab or access browser credentials.
The content controller installs its observer before filling an empty qualified
native textarea and clicks Send at most once. After that click, normal replacement
of Send with Stop does not cancel receipt tracking. User interference, navigation
and abort still terminate conservatively. The old read-only diagnostic extension
is unchanged on the user's computer.

Build a NEW directory with `scripts/build-dot-control-extension.mjs --config FILE
--output ABSOLUTE_DIRECTORY`. The pinned config contains only page/room anchors,
generation, fixed native host name and explicit enabled boolean. The package has
`nativeMessaging`, `scripting`, `alarms` and `https://chatgpt.com/*` host permission;
it has no cookies, debugger, externally-connectable or web-accessible-resource
permission. Browser host permission applies to the origin even though application
code restricts use to the one configured dot URL. The builder records hashes and
does not install or register anything. User approval of the wider permission scope
is required before installation.

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

### Diagnostic host and CLI

`dot-canary-main` has only `enqueue CONFIG UUID TEXT` and `status CONFIG UUID`.
The text must start with `[VKODEX-DOT-CONTROL-CANARY:<UUID>]` followed by a newline
and a non-empty body, with a 2,000-character cap. Status reads the existing DB
read-only without migration/recovery and returns no message text. Reusing the
same request ID and payload is a no-op; changed payload under that ID refuses.

Configuration requires `version: 1`, `mode: diagnostic-canary`, an absolute local
`databasePath` ending in `dot-control-canary.sqlite`, and pinned peer/owner/room,
generation and page URL. This initial qualification uses an explicitly isolated
diagnostic instance of the existing BridgeStore, never the production database.
Production basenames, linked DB files and UNC paths are refused. This is not a
new VK polling consumer or an alternative production inbox implementation.

The Windows native host validates its launcher-supplied extension origin,
acquires an OS-lifetime singleton pipe that accepts no commands, initializes the
existing private bounded diagnostic log, and performs startup recovery only
after exclusive ownership. It waits for a queued marked input, checks the live
scoped browser status and invokes the shared control service once. Unknown
post-send DB errors remain unknown, not queued. No source/classical task or
production restart intent is used or modified.

`native-launcher-preparation.ts` generates/compiles a separate Windows wrapper
in an exclusive new directory. It pins and holds runtime/entry/config files
against writes during child execution, validates the expected extension origin,
clears NODE_OPTIONS/NODE_PATH, copies binary stdin/stdout, suppresses raw stderr,
and bounds shutdown of only its own child. Incomplete output drain cannot return
child-success. Source, pins and compiler paths are local-drive-only. This helper
does not register a host or install an extension.

`windowsUnpackedExtensionId` predicts a keyless unpacked extension's Windows ID
from its exact path following Chromium's algorithm. It does not prove which
extension is installed. Installation must still enforce a single allowed origin
and verify the resulting Native Messaging connection; no wildcard fallback.

Preparing files is not activation. Registering the host and granting the new
extension permissions remain explicitly gated by owner approval. Existing
diagnostic-extension state, its failed operation receipt and the old VK bridge
remain separate from this new qualification path.

Automated fixtures cover framing, wrong-scope replies, acknowledgement versus
acceptance, duplicate/concurrent requests, disconnect, timeout/late result,
durable operation lookup and log redaction. These are not live UI evidence.
Before activation, run one automatically coordinated marked canary, save its
structured result, independently verify the exact visible message identity, and
test reconnect without replay. Never ask the user to post an armed-status report
between starting the observer and submitting the canary.
