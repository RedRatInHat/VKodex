# Desktop IPC host routing for dot

Status: protocol investigation and offline transport support. No new live input
adapter is enabled by this change. This is not full conversation synchronization.

## Evidence boundary

The installed application build 26.930.7945.0 exposes host-scoped request
envelopes. Its request broker preserves `hostId` and passes it to handler
discovery and version checks. Generic follower handlers evaluate the supplied
host, while `thread-owner-discovery` additionally compares its requested host
with the handler's registered host. A negative owner-discovery result therefore
does not establish that every host-scoped follower operation is unavailable.

One authorized read-only `thread-follower-load-complete-history` request with
top-level `hostId: "durable"` and qualified wire version 2 reached an application
handler. It returned `Failed to load complete conversation history`. Static
source inspection locates this error after history loading when a complete
canonical island or complete legacy history cannot be assembled. This differs
from the broker's `no-client-found` result. The exact history failure cause and
responding client identity were not established by the recorded response.

No user-message start or steer was executed by that probe.

## Reuse existing transport

`DesktopIpcClient.request` now accepts an optional destination `hostId` in its
options. It writes that value in the envelope, not inside `params`. Existing
callers omit it and retain their previous wire shape. Callers remain responsible
for supplying a separately qualified host-scoped wire version. There is no
automatic version upgrade, host substitution, retry, owner claim, or fallback.

The optional field provides routing only. It does not establish permission,
authenticate an owner, qualify a message's author, or enable a dot route.

## Candidate input path, not a completed integration

The application's ordinary durable-Aeon input path can choose the internal
`turn/addUserMessage` extension rather than a normal `turn/start`. Its observed
qualification includes a durable host/conversation, Aeon kind/source, a nonempty
client message identity, text-only nonempty input, and absent `toolOutput`.
The application can generate the message-group identity when omitted from a
qualified start context. A bridge should not substitute the conversation ID or
guess that group's format.

This internal implementation is not a documented standalone external API.
Any future adapter must preserve the application-owned admission path, validate
actual host/owner scope, and verify user-visible author identity and deduplication.
Do not call a private service endpoint or fabricate a user identity to emulate it.

## Outstanding qualification

- Observe the correctly bound current snapshot/patch stream without requiring
  all durable history to become one complete island.
- Establish an authorized input operation and its acceptance/reconciliation
  evidence before enabling a live route.
- Verify app and VK visibility, ordering, reconnects and truthful status through
  the shared mirror, delivery and activity components.
- Retain uncertain outcomes without automatic resubmission.

Offline wire tests and the single history read do not satisfy these gates.
