# Dot conversation synchronization: architecture and acceptance contract

Status: design, not implemented or qualified. The current native relay remains an experimental request/reply transport.

## User-visible invariant

The ChatGPT app and the dedicated VK peer must represent the same conversation: owner messages from either surface, public assistant replies, ordering, author attribution, lifecycle state and reconnection behavior. A message accepted by an agent's internal execution thread is not evidence that it exists in the visible conversation. A VK API acknowledgement is not visual confirmation by the owner.

## Reuse boundaries

- `TaskMirror`: normalized user/progress/final events, ordering grace, event identity, own-operation suppression, chunking and duplicate protection.
- `TaskActivity`: observed running/idle/approval/error/disconnected state and standalone activity messages. Never infer model thinking from a long-lived active coordinator turn alone.
- `BridgeStore` and delivery: durable ingress/outbox, accepted/uncertain outcomes, recipient binding and restart recovery.
- `BridgeChat`: existing VK send/edit interfaces. No second VK long-poll consumer.
- `bridge/diagnostics`: shared sanitized timing records; no prompt text, reply text, credentials or native history in diagnostics.

Provider-specific code should be an adapter, not another implementation of these mechanisms. Codex-specific controls (worktrees, model settings, native goal controls) must remain capability-gated rather than fabricated for dot.

## Provider qualification before implementation

A dot conversation adapter needs evidence for all of the following:

1. A canonical visible-conversation identifier, distinct from the durable execution-thread ID where necessary.
2. An authorized submission operation that creates an owner-authored visible message and returns an identifiable acceptance receipt.
3. Ordered visible events with stable message/operation identities, author roles and reconnect cursors.
4. Public assistant output independent of reasoning, arbitrary tool arguments and private handoffs.
5. Lifecycle observations with defined freshness and semantics, including unavailable/unknown rather than invented status.
6. Reconciliation after an unknown mutation result without resubmitting the same request.

The currently tested native `send_message_to_thread` and `read_thread` establish execution-thread delivery, not item 2. This adapter must not advertise full synchronization until the visible conversation contract is established. Do not use text equality for deduplication, synthesize owner messages as assistant messages, or extract browser credentials to manufacture a transport.

## Migration sequence

1. Measure existing behavior with the common diagnostic pipeline and preserve the old journal.
2. Qualify the provider contract with a bounded round trip while observing BOTH interfaces.
3. Map provider events and receipts onto existing bridge contracts; minimize changes to common code.
4. Test adapter contract failures and the existing Codex path together.
5. Migrate only after establishing a stable correspondence between old identities, new operation identities and the baseline; never replay history to guess the correspondence.
6. Perform controlled deployment with restart recovery and a verified rollback boundary.

## Acceptance checks

- A unique message from VK appears once as an owner message in the app and causes one accepted request.
- A unique owner message from the app appears once in VK without being submitted back.
- Two identical messages remain two distinct messages when their identities differ.
- Public replies appear during an ongoing turn, without waiting for its termination.
- Changes in state and disconnects are truthful, timely and do not show a perpetual thinking animation while the source is sleeping.
- Restart during an uncertain submission cannot create a duplicate execution.
- Switching or closing the conversation tab does not corrupt the conversation binding or replay old messages.
- Private reasoning, credentials, approval widgets and unrelated chats never enter the mirror.
- Existing Codex chat mirroring, controls and recovery remain unchanged.

Latency targets must be measured rather than invented: record ingress, native dispatch duration, snapshot duration, public-reply discovery, delivery enqueue, attempt and acknowledgement. Compare source visibility and VK visibility separately. These diagnostics are evidence only, not delivery authority.

## Shared ingress adapter (experimental, not routed)

`src/dot-browser/input-journal.ts` reuses `BridgeStore.receiveInput`, the existing
`bridge_inbox` state machine, immediate SQLite transactions, and normal
`BridgeStore.recover()` semantics. It does not introduce a second inbox, database,
long-poll client, synthetic Codex task or turn ID. Only provider receipt metadata
and the active room attempt are namespaced in the existing value store.

An in-memory or non-regular store is rejected before a dispatch journal can be
constructed. The caller must authenticate the VK sender, exclusively route a configured peer
and separately qualify browser execution. This class rejects another sender/peer,
existing Codex bindings, silent room/generation rebinding, changed payloads under
one event identity, and unsupported edits/replies/attachments/actions. Two equal
texts with different VK event IDs stay distinct. One room submission is fenced at
a time. The sending state is committed before a caller may touch the composer.

A same-node visible receipt settles the common inbox and stores the exact canonical
message ID for echo suppression in one transaction. A timeout, crash, or normal
startup recovery keeps the attempt uncertain. Late DOM observations and matching
text cannot clear recovered uncertainty or authorize another submission. Received
but undispatched messages remain in the shared replay queue. Explicit recovery
only releases an attempt already classified uncertain by the common store.

This is library code and fixture coverage only. Runtime ingress routing, browser
transport/authentication, outbox projection, recipient lifecycle, migration and
live qualification are still required before activation. The old native relay is
not imported, replaced or enabled by this module.

Before each room dispatch transaction, `BridgeStore.requireDurableWrites()` checks
SQLite synchronization and raises that connection to FULL if needed, preserving
EXTRA. A local file-backed fixture demonstrated WAL with synchronous=NORMAL under
the installed SQLite build; NORMAL can lose committed fences on power loss. No
inference is made about past outages or the live Windows DB. The new preflight is
only invoked by this unactivated adapter; it changes neither global SQLite
defaults nor any existing runtime entrypoint. It refuses an enclosing transaction.
Hardware/fsync compliance and destructive power-loss behavior are not tested.
The durability distinction follows the official SQLite
[PRAGMA synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).

## Shared outbound projection (experimental, not routed)

`room-outbox.ts` projects qualified visible messages into the existing
`BridgeStore.enqueue`/`DeliveryWorker` pipeline, reusing VK random IDs, saved
handles, revisions, edits, chunking, retry/rate-limit handling and withdrawal.
There is no second outbox or VK client and no fabricated native task/turn.
The adapter reserves the same peer/room/generation as ingress, establishes FULL
SQLite synchronization for its shared connection, and starts disabled. Baseline
creation is explicit and irreversible through this interface; old rows are not
replayed. Observation now retains the complete loaded ID order, including
unsupported rows, so a gap cannot be hidden by filtering unsupported content.

The common delivery worker has an optional additional recipient restriction,
checked both before and after asynchronous access checks. The room composite gate
requires the exact enabled route and registered delivery key. Unknown room keys
cannot fall through to ordinary Codex access. A Codex binding taking that peer,
or a disabled route, prevents further room sends. Other recipients retain the
ordinary gate and queue behavior.

Owner messages from the app are labelled as such in VK. Committed exact receipts
suppress VK-origin echoes; identical text with distinct IDs remains distinct.
Projection waits while a submission is active. An uncertain submission retains a
persistent outbound barrier even after later inputs succeed: no text-based echo
reconciliation or automatic reset is implemented. This deliberately blocks new
projection until a future explicit reconciliation path resolves the uncertainty.
Already queued valid deliveries remain independent of source polling.

Missing anchors, unknown insertion before the anchor, author changes or malformed
observations roll back the projection transaction. Unsupported content gets an
explicit placeholder, not silent omission or invented attachment support. It may
later be replaced by supported text under the same message handle. Unsupported
links/attachments, baseline edits and VK-origin edits are not full-fidelity sync.
No source completion/typing state is fabricated. Existing shared commentary edit
throttling still applies; latency must be measured in the live integration.

All evidence here is fixture-based (including the real common delivery worker
with a fake chat transport). Live browser transport, authenticated admission,
uncertainty reconciliation UI, startup/router integration, native-journal migration,
recipient qualification and controlled deployment are still outstanding.
