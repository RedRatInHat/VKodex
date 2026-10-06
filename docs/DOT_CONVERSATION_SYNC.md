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
