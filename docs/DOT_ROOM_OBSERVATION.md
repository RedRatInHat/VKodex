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
