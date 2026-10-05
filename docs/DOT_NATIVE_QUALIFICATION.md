# Native dot route (experimental)

Status: **native transport qualified; live VK acceptance pending** (2026-10-05).
The browser prototype was withdrawn. This route uses neither a browser session,
an extension, DOM scraping, nor a second model to relay each message.

## Verified evidence

Observed app build: `OpenAI.Codex_26.930.2377.0` on Windows.

- The official installed `codex-app-tools/server.mjs` accepts standard MCP
  initialization (`2024-11-05`) over stdio. It uses the app-provided local pipe.
- A standalone Node script read the intended durable dot via `read_thread`.
- A separate standalone Node script sent one uniquely marked control message
  via `send_message_to_thread`; the intended dot independently received it.
- A detached Node process waited three minutes after its owning task's model
  turn ended, then successfully read the dot. Its result file predates the next
  executor model turn. An intermediary model need not remain running.
- Tests use the actual calling task's ID and host, never the target as caller.
  No turn ID, authentication token, or trusted renderer identity is fabricated.
- Sandbox `spawn EPERM` required the ordinary reviewed execution escalation.
  No sandbox settings or native access checks were modified.

These are version-specific observations, not a public API compatibility promise.
The application still needs to be running and have a ready app window.
Tab-switch/closure and application-restart tests remain outstanding.

## What is read

Public text is extracted ONLY from completed native history items matching:
`mcpToolCall` / `codex_apps` / `user_message.send_message` / `channel: chatgpt`.
The snapshot must bind the configured dot ID and durable host. General assistant
items, reasoning, commands, other tools/channels, widgets, secure handoffs and
confirmation cards are excluded. Raw history is neither logged nor persisted.

The native formatter preserves call arguments/status but omits the tool result.
Consequently this is evidence of a completed public-message invocation, not an
independent ChatGPT room-delivery receipt. Completed calls in interrupted or
in-progress turns are eligible. Pagination lives under `snapshot.page`.

The first successful read establishes a baseline without forwarding old history.
Subsequent reads overlap saved turns and deduplicate public call IDs. An absent
pagination anchor stops collection rather than silently skipping a gap.

## Architecture

- `mcp-client.ts`: official MCP subprocess, exact caller/target binding, bounded
  messages/timeouts, no model overrides, no automatic mutation retries.
- `public-replies.ts`: strict public-text allowlist.
- `relay-store.ts`: separate SQLite inbox/outbox, fixed recipient binding,
  persistent duplicate suppression, crash-to-uncertain input state.
- `relay.ts`: one dedicated VK peer, authenticated owner-only input, public
  output chunking and stable VK `random_id` values, read reconnection.
- `runtime.ts`: optional configuration, absent by default.
- The existing VK gateway/Long Poll handles both routes. No second poller is
  started with the same token. Existing Codex conversations remain on their
  original route. Dot recovery queries only its configured peer.

New text messages are supported. Inbound files/edits get an explicit unsupported
notice. Outbound attachment captions include a note to open files in dot;
attachment identities/files are not copied. Approval widgets stay in dot.

## Local provisioning contract

`<BOT_DATA_DIR>/dot-native.json` is local-only and must never be committed.
It contains exactly these fields:

- `version`: 1; `enabled`: true
- `peerId`: a newly provisioned, dedicated VK conversation ID
- `threadId`: the existing intended dot
- `callerThreadId`, `callerHostId`: the genuine app task owning the bridge setup
- `pluginRoot`: absolute directory of the official installed app-tools plugin
- `pipePath`: the actual `CODEX_APP_TOOLS_PIPE_PATH` inherited by that task
- `inboundAfterMessageId`: trusted VK baseline recorded when provisioning

The VK owner ID and token are reused through the existing gateway configuration;
the dot file cannot override them. Existing Codex-bound peers are rejected.
The journal is `<BOT_DATA_DIR>/dot-native.sqlite`. Do not reset its baseline or
rebind it to another recipient. Queued input survives outages; uncertain input
blocks following prompts until evidence resolves it. Never blindly resend it.

The pipe address may change after the desktop app restarts. Automatic fresh
endpoint discovery is NOT implemented: refresh it only from a genuine new app
executor context, without token extraction or pipe guessing. Keep the route
unavailable until the real context is available. A service restart with the
same live app endpoint retains the journal.

## Testing and remaining gates

Native-focused offline tests cover the allowlist, MCP binding, target mismatch,
no mutation replay, rejected approval requests, baseline/pagination gaps,
owner/peer isolation, outbox idempotency, Unicode splitting and journal restart.
The test preload blocks non-loopback HTTP/HTTPS/fetch/TCP/DNS before sending.
An older callback test's incorrect `api.call` mock was corrected to
`api.callWithRequest`; real VK is not needed for unit tests.

Before production readiness:

1. Verify the exact build on Windows and provision the dedicated VK peer.
2. Test owner VK prompt → intended dot → the same VK peer.
3. Test duplicate VK delivery, repeated native polling and a bridge restart.
4. With the owner, switch/close the dot tab while leaving the app running.
5. Qualify app-restart endpoint refresh and uncertain-send reconciliation.

No live VK success, complete app-lifecycle resilience, or research experiment
is claimed by this document.
