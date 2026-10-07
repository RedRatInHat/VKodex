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

## Evidence and limits

A successful result is same-node DOM-transition evidence only. Independently check
the canonical ID and authenticated owner attribution in visible room history.
Missing pending evidence, remount, wrong tab/room, navigation, timeout, disconnect
or session loss are uncertainty. Never retry the same message because its receipt
is missing. Session storage is cleared by browser shutdown; the extension never
reopens tabs or rearms on startup. It does not solve production reconnect or
uncertainty reconciliation. Fixture tests are not a live browser qualification.
