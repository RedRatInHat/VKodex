# Read-only dot room observation

Status: experimental read-only module, disconnected from live bridge routes.
This does not implement browser submission or full conversation synchronization.

## Verified layout

The observed web dot room renders one `article.message-row[data-message-id]`
per message. The nested `.message-body` repeats that ID; treating both as
messages produces duplicates. IDs are full room-qualified strings, not bare
Sentinel suffixes. The exact ID must be preserved.

The independently checked owner anchor has the `self` class; the dot anchor
does not. Both message bodies can use the same `assistant-message` markdown
style. That style must never determine authorship. The observed
`grouped-previous` and `grouped-next` classes affect presentation, not authors.

A read-only check of 32 loaded rows found 12 owner-layout rows and 20 other
rows. Their IDs, order and layout-role flags survived one page reload unchanged.
This is evidence for that loaded window only, not a stable platform API.

## Module boundary

`src/dot-browser/room-observation.ts` collects a supplied document and qualifies
its rows against an exact dot URL, room identity and two independently verified
role anchors. Missing anchors, unexpected layout classes, duplicate IDs,
cross-room IDs, nested body disagreements and size-limit violations reject the
whole observation. The caller cannot interpret that rejection as permission to
rebaseline, replay history or submit another message.

Text is read from `.message-text`, excluding reaction/reply controls. Markup
outside the conservative text allowlist is explicitly unsupported: links,
attachments and widgets are not silently flattened into an apparently complete
message. Distinct messages with identical text remain distinct. No content hash
is used as message identity.

Results are deliberately `partial-room-observation` with
`completeHistory: false` and `authoritativeAuthors: false`. Display-role evidence
is not authenticated user input and must not authorize execution. The module
does not fabricate a native turn ID, completion state, cursor or submission
receipt to fit the existing task mirror.

The compiled collector was also evaluated through the authorized read-only
browser DOM interface. It returned 32 supported text observations (12 owner,
20 dot display roles) and one explicit unsupported row in the later 33-row
window. Only aggregate counts were retained; no private conversation fixture
is part of this repository.

## Tests and remaining work

Synthetic tests cover binding and author-anchor mismatches, full ID retention,
duplicate text/IDs, unknown content, limits and scoped DOM collection. The
synthetic DOM fixture is not a real browser test. The live read-only check is
separate evidence and does not prove send, reconnect, missing-window recovery,
attachment support, lifecycle state or tab-close behavior.

There is no extension, permission grant, browser connection, observer loop,
network request, storage, UI input or VK delivery in this module. It is not
enabled by configuration and has no production caller. A future qualified
adapter should reuse existing mirroring/delivery/activity contracts rather than
create a second VK long-poll or outbox. Submission and identity reconciliation
must be qualified independently before a live route is enabled.

## Subsequent single visible-composer check

A separately authorized single UI submission into the same dot conversation
was confirmed in both the room-history tool and the visible DOM. The room
history attributed the input to the authenticated owner and the response to
the assistant, with distinct stable message IDs. There was one click and no
resubmission. This qualifies that visible round trip, not an automated VK bridge
or failure/reconnect behavior. No extension or private API was used.

## Submission evidence and uncertainty

Static renderer inspection shows the optimistic message's `id` and `requestId`
initially coincide. Pending `data-message-id` therefore exposes that client
request ID. After confirmation the attribute becomes the canonical server ID.
The renderer uses `requestId || id` as its React key, but React keys are not DOM
attributes and do not guarantee physical article continuity. No dedicated
request-ID/idempotency DOM attribute was found in the inspected renderer.

`submission-observation.ts` is a pure, disconnected evidence tracker. It permits
only a pending UUID to canonical room-ID transition on the **same physical
article**, in the **same observer epoch**, after an externally persisted dispatch
fence. The adapter must identify physical nodes with an epoch-local WeakMap;
it must not derive node identities from text, position or React internals.
Text equality is a consistency filter, never the proof of submission.

Missing optimistic evidence, remounts, navigation, timeouts, changed epochs,
interference, duplicate pending candidates and cross-room IDs remain uncertain.
A new server row containing matching text cannot clear that uncertainty.
Rehydrating an unfinished attempt after restart also remains uncertain. Even a
complete transition is labelled DOM observation, not an authenticated server
receipt. The tracker has no click, send, retry or persistence method.

Synthetic tests cover these transitions. Physical pending-to-server article
continuity has **not** been live-qualified. No MutationObserver driver or
extension is installed by this change, and it does not enable automatic input.
The future integration must commit evidence to the existing durable lifecycle
before advancing its queue; losing that commit cannot authorize a replay.

## One-operation DOM watcher (not installed)

`submission-dom-observer.ts` connects the pure submission tracker to a real
`MutationObserver` interface. Its caller must already own the composer exclusively
and have committed a durable dispatch fence. It only reads the DOM and subscribes
to DOM/navigation events. It does not click, fill, retry, connect to a browser,
install an extension, or make network calls.

The watcher qualifies the initial room with the same conservative row reader used
by the history observation module. It retains physical article identities in a
WeakMap. A later acceptance observation requires a captured pending snapshot and
exactly one corresponding ID attribute transition on that same article. If the
browser batches away the pending snapshot, the result is uncertainty, even when
`oldValue` or matching text suggests what happened. Removing/reinserting a node,
remounts, a second owner input, changed page, unsupported markup, missing evidence,
timeout, or disconnect cannot authorize another send. All terminal paths disconnect
the observer and clear its timer/listeners before invoking the persistence callback.

The fixture tests exercise the watcher and lifecycle callbacks without a live
browser, network, or user input. Physical pending-to-canonical continuity in the
actual application remains unqualified. No production entrypoint imports this
watcher. A browser adapter, durable dispatch ledger, common delivery queue wiring,
and separately authorized installation are still needed for an operational bridge.
