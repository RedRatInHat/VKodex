# One-shot observer qualification package

Status: source and fixture tests only. Not installed, connected or armed.

This diagnostic extension observes one separately authorized visible-room canary.
It does not fill a composer, click Send, fetch a URL, access cookies, read profiles,
connect to VK or activate a bridge. It uses the existing conservative room reader
and physical-node submission observer. The normal UI submission is a separate
explicitly approved action performed by the operator.

## Preparation

Run `node scripts/build-dot-observer-canary.mjs --config CONFIG --output NEW_ABSOLUTE_DIRECTORY`.
The config must contain exactly pageUrl, roomId, ownerAnchorId, dotAnchorId,
expectedText (a marked VKODEX control message), and operationId (UUID). Author
anchors must have been independently verified for this room. Do not put credentials,
conversation dumps or unrelated fields in this file. Keep real room configuration
outside Git. Output must not exist; no package is overwritten. The receipt hashes
every emitted file. No installation is performed by the builder.

## Permission boundary

The owner must explicitly approve this diagnostic package before installation.
Requested permissions are activeTab, scripting and extension session storage.
There are no host permissions, optional host permissions, cookies, debugger,
webRequest or externally-connectable permissions. The popup may arm only the exact
configured active dot URL and top-level tab. A session permits one observation;
failed or uncertain arming cannot retry itself. Page observation expires after
120 seconds and disconnects on a terminal result. The popup reports only operation,
phase, timing and canonical message identity, not conversation text.

The operator must obtain approval for the installation and separately scoped new
control message, inspect the current page/draft, arm through the visible popup,
then submit once through the ordinary composer. The previous completed canary is
not permission for another one. Use the browser's normal extension installation and popup UI; do not invoke
private application APIs or extract browser credentials.
After qualification, stop any remaining observer and remove the diagnostic
extension as agreed. No persistent runtime bridge is implied by this test.

Do not ask the operator to post an `armed` status report into the observed chat
before submitting the marker. Any new owner message that is not exactly the
expected marker is interference and terminates this exclusive one-message watch.
The popup button is labelled "Начать одно наблюдение"; `arm` is its internal
command name. After starting, submit only the marker, then inspect/report the
result. Manual sequencing is diagnostic-only and is being replaced by an atomic
observer-plus-submission command in the extension control API.

Terminal receipts retain only a bounded reason: interference, navigation, gap,
disconnect, timeout, transition-rejected or unknown. This is diagnostic evidence,
not permission to retry a submission. Earlier receipts without reasons cannot
be retrospectively classified as a known failure. Source updates do not update
an already loaded extension or change its existing terminal state.

## Evidence and limits

A successful result is same-node DOM-transition evidence only. Independently check
the canonical ID and authenticated owner attribution in visible room history.
Missing pending evidence, remount, wrong tab/room, navigation, timeout, disconnect
or session loss are uncertainty. Never retry the same message because its receipt
is missing. Session storage is cleared by browser shutdown; the extension never
reopens tabs or rearms on startup. It does not solve production reconnect or
uncertainty reconciliation. Fixture tests are not a live browser qualification.

## Explicit uncertainty reconciliation (library only)

`DotRoomInputJournal.resolveUncertain` can record an operator decision for one
exact settled uncertain attempt. The production command/UI that authenticates and
confirms this decision is not connected yet. Do not call it automatically on a
matching text, late observation, timeout, reconnect, or startup.

- `confirmed-visible`: after independent verification of the owner's canonical
  message in the intended room, record that exact ID and suppress its VK echo.
- `release-without-retry`: acknowledge the unresolved outcome and permit outbound
  projection to continue without claiming delivery. An eventual visible owner
  message may therefore be mirrored to VK. No resend is performed or enabled.

The caller supplies a unique reference to the authenticated operator decision,
not the operator's message contents. The operation, observer epoch, input key,
room, peer and generation must still match. Resolution and barrier decrement use
one durable shared-store transaction. Repeating the identical decision is a no-op;
changing a decision or reusing a message/decision for another attempt is refused.
Only that attempt's barrier is released. Other unresolved inputs keep projection
blocked. Original common-inbox uncertainty and observed history remain intact;
manual resolution is separate evidence, not a fabricated DOM receipt. This is
source-level recovery support, not a deployed reconciliation interface.

Startup failure diagnostics distinguish script injection, observer handshake and
room qualification. Content failures expose only fixed categories and aggregate
row count / anchor-presence / exact-page-match flags. Raw exception text, row IDs
and conversation contents are not copied to extension session state. Diagnostics
do not relax qualification or permit automatic rearming. A previous `arm-failed`
result alone does not identify which condition failed.
