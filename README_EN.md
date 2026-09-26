<p align="center">
  <a href="README.md">Русский</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="docs/logo-transparent.png" width="112" alt="VKodex logo">
</p>

# VKodex


**VKodex is an open-source VK bot for remotely controlling OpenAI Codex through VK messages and conversations.**

Continue existing Codex tasks or create new ones from your phone: choose a project in the manager chat, open a linked VK conversation, and send follow-up requests and attachments into the same context.

<p align="center">
  <img src="docs/vkodex-messenger.png" width="786" alt="VK Messenger with the private VKodex manager chat and a separate conversation linked to a Codex task">
</p>

The private chat with the community is the manager. Each separate VK conversation represents one Codex task. Agent progress arrives without notifications; final answers arrive as regular messages.

**Status: experimental Codex integration on Windows.** For every profile configured with `owner: "app-server"`, VKodex keeps one long-lived App Server for commands and events, but a task's stream lease is held only while its turn is running and released after the final answer is durably queued. An idle task can therefore be opened in Codex Desktop or VS Code without the “chat is open elsewhere” warning; the next VK prompt reacquires only that task. If Codex Desktop or VS Code already holds a task's active writer, routing switches to that confirmed client owner before dispatch; there is no automatic fallback after a mutation starts. The launcher is used only by explicit `/open`, so an ordinary prompt does not focus the application window. Codex's internal protocols may change after an update, so compatibility is checked at startup and while the bridge is running. Start by testing with a non-critical task.

## Contents

- [Requirements and connection model](#requirements)
- [Installing VKodex](#install)
- [VK community, API key, and numeric IDs](#vk-api)
- [Configuration](#configuration)
- [Validation and first launch](#first-run)
- [Manager and linked conversations](#usage)
- [Additional Codex data directories](#codex-homes)
- [Continuous operation and VPN routing](#runtime)
- [Updates and backups](#maintenance)
- [Troubleshooting](#troubleshooting)
- [Security and limitations](#security)
- [Legacy Codex SDK mode](#legacy-sdk)
- [Development and license](#development)

<a id="requirements"></a>

## 1. Requirements and connection model

| Component | Requirement |
| --- | --- |
| Computer | Windows with the Codex desktop app running. VKodex must run on the same computer and under the same Windows user. |
| Codex | A working sign-in and access to at least one local project. Before linking an existing task, make sure it responds directly in the app. |
| Node.js | [Node.js 24 LTS](https://nodejs.org/en/download) is recommended. CI also tests Node.js 22. |
| npm | The project and CI use `11.12.1`. |
| Git | [Git for Windows](https://git-scm.com/install/windows) to clone and update the repository. |
| VK | Your VK account, a separate community that you control, and a community access token with messaging permission. |
| Network | A typical setup in Russia needs split routing: VKodex reaches the VK API and Long Poll directly through a Russian IP, while Codex/OpenAI traffic goes through a VPN. |

Install and sign in to the desktop application using the [official Windows guide](https://learn.chatgpt.com/docs/windows/windows-app). Current documentation calls it the ChatGPT desktop app; Codex is used for software-development tasks. Sign-in and first-task setup are covered by the [official quickstart](https://learn.chatgpt.com/docs/quickstart?setup=app).

You **do not need to add `OPENAI_API_KEY` to VKodex** when connecting to an already authenticated desktop app. The Codex task itself determines authentication, model, file access, and command permissions. The VK token belongs to a separate service.

You do not need a public IP address, domain, HTTPS certificate, or inbound port. VKodex receives events through Bots Long Poll. This mode also does not require a separate VK application or a personal VK access token.

Running VKodex on a VPS, in Docker, or in WSL does not replace running it next to the Windows desktop app. Docker files in this repository belong to the [legacy SDK mode](#legacy-sdk). Live desktop integration on other operating systems is not currently supported.

<a id="install"></a>

## 2. Installing VKodex

Run all commands in this guide in **PowerShell**. Open a new terminal after installing Node.js and Git.

Check the tools:

```powershell
git --version
node --version
npm --version
```

Clone the repository into the directory where you want to keep it:

```powershell
git clone https://github.com/RedRatInHat/VKodex.git
Set-Location VKodex
npm install --global npm@11.12.1
npm ci
npm run check
npm run runtime:prepare
```

`npm ci` installs dependencies from the locked dependency tree. `npm run check` type-checks TypeScript, runs the tests, and builds the project; these checks do not need real credentials.

`runtime:prepare` creates a dedicated `VKodex.exe` executable and prints its path. See [process and VPN routing](#runtime) for details.

Create the local configuration. The guard below prevents an existing `.env` from being overwritten accidentally:

```powershell
if (Test-Path -LiteralPath .env) {
    throw '.env already exists. Edit it instead of copying the template over it.'
}
Copy-Item -LiteralPath .env.example -Destination .env
notepad .env
```

Keep the file open for now. The next sections explain how to obtain the token and IDs. Never publish a populated `.env` file.

<a id="vk-api"></a>

## 3. VK community, API key, and numeric IDs

### 3.1. Create a dedicated community

1. Open the VK communities page and create a community for your VKodex installation. The display name and short address can be anything.
2. Make sure your account can administer that community.
3. Do not use a community whose messages are already handled by another bot. Two Long Poll consumers may conflict.

The community shown in the screenshot is an interface example, not a shared server. Use **your own community and your own token** for your installation.

### 3.2. Enable messages and conversations

Open **Messages** in the community management panel and enable community messages.

In the bot settings, enable bot capabilities and permission to add the community to conversations if those options are present. VK may rename these settings between interface versions.

Open the regular community page from your account and send it a message such as `Hello`. This creates the private chat that will become the manager. There is no automatic reply until VKodex starts. Allow community messages if VK prompts you.

### 3.3. Configure Bots Long Poll

Open **Management → API usage → Long Poll API**:

| Setting | Value |
| --- | --- |
| Long Poll API | Enabled |
| API version | **5.199** |
| Incoming-message event | `message_new` enabled |
| Message-edit event | `message_edit` enabled |
| Button-action event | `message_event` enabled |

`message_new` is required for new messages, `message_edit` for synchronizing a corrected last request, and `message_event` for menu buttons. VKodex does not need Callback API configuration, a server URL, or a confirmation string.

Do not select a different version merely because it is newer: the adapter and validation command target **5.199**. Save the changes. Long Poll settings are described by the [official VK schema](https://github.com/VKCOM/vk-api-schema/blob/master/groups/methods.json).

### 3.4. Create a community access token

1. Open **API usage → Access tokens** and create a token.
2. Grant access to **community messages**. Do not add unrelated permissions.
3. Confirm the action using the method requested by VK.
4. Copy the entire token into `VK_GROUP_TOKEN` in your local `.env`.

You need a **community access token**, not an application service token or a personal account token. Do not paste it into bot messages, issues, screenshots, links, or terminal commands that expose the literal value.

If the token is disclosed, revoke it in VK and create a new one. Removing it from a file is not enough.

### 3.5. Find the community ID and your account ID

The configuration uses positive integers:

| Field | Value |
| --- | --- |
| `VK_GROUP_ID` | The numeric community ID, without a minus sign and without `club` or `public`. |
| `VK_OWNER_ID` | The numeric ID of your personal VK account, without `id`. Exactly one user. |

If an address contains `club<number>`, `public<number>`, or `id<number>`, use its numeric suffix. A short name such as `my_vk_bridge` cannot replace the number.

**If only a short address is visible**, resolve it through [`utils.resolveScreenName`](https://github.com/VKCOM/vk-api-schema/blob/master/utils/methods.json). This method accepts a community token. For the command below, `VK_GROUP_TOKEN` must already be populated; both ID fields may still be empty.

Run this from the VKodex directory:

```powershell
$screenName = Read-Host 'Short address without https://vk.ru/ or a trailing slash'
$runtime = Join-Path $env:LOCALAPPDATA 'VKodex/runtime/VKodex.exe'

@'
import { VK } from "vk-io";

const token = process.env.VK_GROUP_TOKEN?.trim();
const screenName = process.argv[2]?.trim();
if (!token || !screenName) {
  console.error("Fill in VK_GROUP_TOKEN in .env and provide a short address.");
  process.exit(1);
}

try {
  const vk = new VK({ token, apiVersion: "5.199", apiRetryLimit: 0 });
  const result = await vk.api.utils.resolveScreenName({ screen_name: screenName });
  if (!result || !Number.isSafeInteger(result.object_id) || !["user", "group", "page", "event"].includes(result.type)) {
    console.error("Profile or community not found. Check the short address.");
    process.exitCode = 1;
  } else {
    console.log("Type: " + result.type + "; ID: " + result.object_id);
  }
} catch (error) {
  const code = Number.isSafeInteger(error?.code) ? error.code : "no response";
  console.error("VK error: " + code);
  process.exitCode = 1;
}
'@ | & $runtime --env-file=.env --input-type=module - $screenName
```

Run it first for the community address, then for your profile address. A profile should resolve as `user`; a community should resolve as `group`, `page`, or `event`. Copy the numbers into the corresponding `.env` fields.

The command only reads IDs: it does not create conversations or send messages. The token comes from the local file and is not printed. The result contains your personal ID, so do not include the output in public reports.

<a id="configuration"></a>

## 4. Configuration

The desktop mode needs these `.env` fields:

```dotenv
VK_GROUP_TOKEN=
VK_GROUP_ID=
VK_OWNER_ID=

BOT_DATA_DIR=./data/desktop
CODEX_HOME=
CODEX_EXTRA_HOMES=[]
CODEX_SOURCES=
VKODEX_PROJECTLESS_ROOT=
HEALTH_CHECK_INTERVAL_MS=60000
```

**You must populate the first three fields.** The empty values above are not a working configuration.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VK_GROUP_TOKEN` | Yes | Full community token with messaging access. |
| `VK_GROUP_ID` | Yes | One positive numeric community ID. |
| `VK_OWNER_ID` | Yes | One positive numeric owner ID. Messages from other users do not control manager functions. |
| `BOT_DATA_DIR` | No | Private database, queue, files, and bindings. The desktop adapter uses `./data/desktop` by default. |
| `CODEX_HOME` | No | Primary Codex data directory. An empty value means `~/.codex`. This is not a source-code project directory. |
| `CODEX_EXTRA_HOMES` | No | Backward-compatible JSON array of additional Codex data directories, up to 16. |
| `CODEX_SOURCES` | No | Preferred JSON array of sources with `home`, `owner`, and a launcher. `owner: "app-server"` enables autonomous profile ownership; the launcher is used by `/open`. When set, it replaces `CODEX_HOME` and `CODEX_EXTRA_HOMES`. |
| `VKODEX_PROJECTLESS_ROOT` | No | Root for automatically created empty workspaces used by **No project** tasks. The default is the user's local application-data directory; on Windows, `%LOCALAPPDATA%/VKodex/workspaces`. |
| `HEALTH_CHECK_INTERVAL_MS` | No | Full operational-check interval. Default: 60 seconds; allowed range: 30 seconds to one hour. |

The shared `.env.example` retains settings for the legacy SDK bot, including `BOT_DATA_DIR=./data`. For the current desktop bridge, set **`BOT_DATA_DIR=./data/desktop`** so it does not reuse the old mode's database. Preserve your current path if you already have a working desktop installation elsewhere.

`MAX_INBOUND_FILES`, `MAX_INBOUND_FILE_BYTES`, `MAX_INBOUND_TOTAL_BYTES`, and `DOWNLOAD_TIMEOUT_MS` configure inbound files for the desktop adapter. Other legacy SDK-mode settings, including `VK_OWNER_IDS`, `VK_ALLOWED_USER_IDS`, `WORKSPACE_ROOTS`, `CODEX_MODEL`, and `CODEX_APPROVAL_POLICY`, do not configure it. Desktop mode uses singular **`VK_OWNER_ID`**. Permissions and the current model come from the Codex task; the menu can change the model for the next turn.

Restart only VKodex after changing `.env`. You do not need to close active Codex tasks.

<a id="first-run"></a>

## 5. Validation and first launch

### 5.1. Validate VK

```powershell
npm run vk:check
```

A healthy configuration reports `OK` for every check:

```text
messages_permission
long_poll
message_new
message_edit
message_event
event_version
long_poll_server
```

This command is read-only: it does not create conversations, send messages, or connect to Codex. Fix every `FAIL` before starting the bridge.

A successful result confirms messaging and Long Poll permissions. Conversation creation and invite-link generation are tested separately when you link the first task.

### 5.2. Validate the Codex catalog

Open Codex and the task you intend to link, then run:

```powershell
npm run desktop:probe
```

The command prints the number of sources, tasks, and projects. Catalog inspection does not require a VK token. If `taskCount` is zero or `unreadableSources` is greater than zero, check the configured data directories.

If you know a task ID, you can also test a live subscription:

```powershell
$threadId = Read-Host 'ID of an open Codex task'
npm run desktop:probe -- $threadId
```

This probe only reads state. It does not send prompts or start a turn. `subscribed: true` confirms a successful connection. If the same ID exists in multiple directories, the probe asks you to select a source; the regular manager also keeps those copies separate.

### 5.3. Start the bridge

The build is ready after a successful `npm run check`:

```powershell
npm run desktop:start
```

For TypeScript development:

```powershell
npm run desktop:dev
```

Choose **one** command. Never run two instances with the same community or database. `npm start` and `npm run dev` launch the separate legacy SDK mode.

Wait for:

```text
VKodex desktop bridge: VK Long Poll started.
```

Keep the terminal and Codex running. After a few seconds, inspect the first report:

```powershell
npm run health:check
```

It should finish with `Health: OK`. To stop the bridge normally, press **Ctrl+C in its terminal**. This does not stop a Codex task.

### 5.4. Link the first task

1. Open the private chat with the community from the configured owner account and send `/menu`.
2. Select **Codex tasks** or send `/list`.
3. Select a project, **No project**, or **All tasks**, then select the task.
4. The bot creates or finds a linked VK conversation and sends its link to the manager.
5. If VK did not add you automatically, join through the link. Streaming is already enabled; there is no separate join confirmation.
6. Send a simple test prompt in the linked conversation, for example: “Briefly describe the current task without changing anything.”
7. Confirm that it reaches the **same desktop task** and that the answer appears in VK.

Use a non-critical task first. The internal application protocol is not a stable public API, and the project tests cannot guarantee compatibility with every Codex release.

<a id="usage"></a>

### Optional client-owner adapter

Tasks owned by VKodex's profile App Server do not need this adapter. It is only needed for safe source archival when VS Code already holds the task writer: `VKodexOwnerLauncher.exe` forwards the request through that client's App Server. It is not a second turn executor or a timeout fallback.

Prepare on Windows after `npm run build`:

```powershell
./scripts/prepare-owner-launcher.ps1 `
  -CodexHome 'C:\CodexProfiles\work' `
  -NativeExecutable 'C:\Path\To\Native\codex.exe' `
  -Destination 'C:\VKodexAdapters\work-v1'
```

Select the client's actual native CLI, not another adapter executable. The installer creates a separate package and private local channel; it does not change client settings or running processes. For standard VS Code extension installations, the package follows `extensions.json` across extension updates. Ambiguous entries or a mismatching manifest prevent startup.

- **VS Code:** set `chatgpt.cliExecutable` in the selected profile to the generated `VKodexOwnerLauncher.exe`. This is an experimental extension setting.
- **An existing client:** new environment variables cannot attach the adapter to an existing App Server. Initial activation requires a safe client restart; do not restart during tasks or while a browser session must be preserved.
- **Rollback:** restore the previous CLI setting or remove `CODEX_CLI_PATH`, then restart the client when safe. The adapter does not rewrite task history.

Do not inject the adapter into Codex Desktop and do not set a global `CODEX_CLI_PATH`; VKodex does not support that setup and it can prevent the application from starting. Owner-mediated archival has been verified in a separate VS Code profile. The source and all unarchived descendants must have confirmed idle status and inactive goals. Unknown, unloaded or running descendants block archival; the adapter does not automatically load or stop them. Uncertain archival is never retried automatically. The `owner-transports` directory contains local access tokens: never publish it or send it to VK.

## 6. Manager and linked conversations

**Long incoming messages:** in a linked conversation, text of at least 3,000 characters starts a collection window. Subsequent text parts from the same author are joined with newlines after 1.5 seconds of silence, up to 64,000 characters per request. Short trailing parts are included; commands, attachments and a different author end the batch and are processed separately. VK provides no split-message identifier, so this is a heuristic: a gap longer than 1.5 seconds produces a separate request. Editing an individual part after merging changes VK only. Every part and batch state is stored in SQLite before dispatch: an unfinished collection resumes after restart, while a batch that may already have reached Codex is never sent automatically again.

### Manager

The manager is the **private chat with the community**, not another group conversation.

| Command or button | Action |
| --- | --- |
| `/menu`, `/start`, `/status` | Open the bridge menu and technical summary. |
| `/help` | Show the manager's supported commands. |
| `/health`, **Check health** | Immediately recheck VK, queues, SQLite, Codex catalogs, goals API, named pipe, stream protocol, and active streams. |
| `/load`, `/pc` | Sample current CPU, memory and disk usage, OS uptime, and the VKodex process CPU, memory and PID. Manager-only; the command is never forwarded to an agent. |
| `/limits`, **Codex limits** | Show the data directory, account, used limit percentage, reset time, plan, and credits. When Codex reports an available reset credit, this screen also offers a manual reset button with a separate confirmation. The manager shows every configured profile; a task conversation shows only that task's account. The command is not forwarded to the agent. |
| `/list`, **Codex tasks** | Select a project, then select a task. |
| `/new`, **New task** | Create a user task: Codex catalog → project or **No project** → local folder or separate Git worktree → title → initial prompt → model → reasoning effort. |
| `/cancel` | Cancel an unfinished new-task wizard. |
| **Projects** | Show project names and working directories. |
| **No project** | Show tasks confirmed to have no project. |
| **All tasks** | Show all discovered user tasks, including tasks whose project is unknown. |
| **Choose project** | Return to project selection. |
| **Refresh** | Refresh the current screen. |
| **Disable streaming** | Remove the VK binding without deleting the Codex task. |

Lists are paginated and preserve the selected project while paging. Archived and internal agent tasks are hidden. A title comes from the Codex title index first, then the local database. A long initial prompt is never used as a fallback title.

Manager service responses contain a **Menu** button. The menu shows the bridge process and uptime, task and binding counts, delivery queue, and latest full health report. The full menu appears only on request; the bot does not send a separate greeting at startup.

Inbound events are serialized independently per VK conversation. A stalled task connection cannot block the manager or other tasks. After 45 seconds, a watchdog reports the delay but preserves that conversation's ordering until the call settles; state-changing operations are not retried automatically. Other conversations continue through their own queues.

A new task is created atomically through the App Server for the selected `CODEX_HOME`: the operation materializes a permanent thread ID and accepts its first turn before returning. First-turn events emitted before the VK conversation is ready are stored in SQLite, so restarting the bridge between task creation and binding does not lose the final answer. After the short creation session finishes, every later turn uses the long-lived profile owner; if a UI client already holds the writer, routing switches to that client before dispatch. This path does not need a launcher. The creation session cannot continue existing tasks and is never used as a fallback. For a project task, **Local** mode uses the project's saved working directory. **No project** does not require typing a computer path from a phone: VKodex creates a separate empty directory under `VKODEX_PROJECTLESS_ROOT`, selects local mode, and stores the task without a project assignment. **Choose folder** opens a paginated button list of known workspaces collected from projects and existing tasks in the selected catalog; choosing one does not assign the new task to that project. The same screen retains an empty-folder option and manual path entry as a fallback. **Separate worktree** mode calls `git worktree add --detach` and creates a neighboring directory named like `<repository>_VKodex_<identifier>_worktree`; the source directory must be a Git repository, and worktrees are not deleted automatically. If the first turn starts but the following VK response is lost, the wizard marks the result as uncertain and does not create a duplicate.

### Task conversation

A regular message continues the linked task. During an active turn it becomes a steer; after completion it starts the next turn in the same context. Any participant in the linked conversation may author a prompt: the bridge ignores only its own community messages and already processed outbound messages. While only the owner has actually written in the conversation, VKodex forwards clean text without attribution. After another user writes for the first time, the bridge prepends later requests with transport metadata containing the author's display name and VK ID, allowing Codex to distinguish participants in a shared conversation; observed authors persist across restarts, profile names are cached, and the ID remains available if the VK API lookup fails. The block is explicitly marked as attribution rather than an instruction. The bridge does not inspect the participant list. A request is not retried automatically when Codex state is uncertain or a response was lost.

An edit made in VK is synchronized to Codex only for the same author's latest message when that message started a standalone turn through the live desktop owner. VKodex interrupts an unfinished turn, invokes Codex's native last-request edit, deletes VKodex output from the discarded branch, and starts the corrected turn. Commands and workspace file changes already performed by the discarded turn are not reverted. A steer sent during an active turn, an older message, or a turn followed by another steer is not rewritten; the edit remains in VK and the bot explains why.

If a binding was explicitly disabled through `/detach` or archiving, a new message does not silently enable it. The private manager receives an explanation and a reconnect button. Reconnect, then repeat the original message. For a conversation that has never been linked, the manager offers the task list. Leaving the conversation or changing its participants does not disable the binding.

The **Task menu:** line and **Menu** button are appended to the final Codex answer; for a split answer they appear only on the last part. The bridge sends no separate menu message when linking a task or completing a turn. The button opens a fresh card even if earlier settings buttons are stale. Before the first answer, use `/menu`.

| Action | Result |
| --- | --- |
| `/menu`, `/status` | Open the task's technical card. |
| `/help` | Show commands supported in this conversation. |
| `/open`, **Share** → **Open in Codex** | Explicitly bring the configured Codex client to the foreground and open this task. An ordinary prompt never invokes the launcher or focuses a window. |
| `/files` | Scan this binding's outbox and send new completed files to VK. |
| `/goal`, **Goal** | Show the Codex goal, status, budget, token use, and elapsed time. The menu can set or edit the objective and budget, pause, resume, or clear it. The agent marks a goal complete after verifying the result. |
| **Model / reasoning** | Select a model and reasoning effort for the next turn from the available Codex cache. The current turn is not interrupted. |
| **Refresh** | Refresh status, model, and context-window utilization. |
| **Rename** | After text input and confirmation, save the title in Codex and rename the VK conversation to `[VKodex] <title>`. A rename made directly in Codex is also synchronized to VK. |
| **Archive** | Archive an idle task after confirmation and disable its stream. |
| **Working directory** | Send the task directory as text. |
| **Deep link** | Send a local link that opens the task in the desktop app. |
| **Markdown file** | Export visible conversation history if it is complete and at most 2 MiB. |
| **Share** | Explicitly open the app, send the deep link, or export. A public share URL is not created automatically. |
| **Move to project** | Save a new Codex project assignment or remove the task from its project. This does not move an existing task's working directory. |
| **Move** → **Another profile** | Create a native fork of completed history in another `CODEX_HOME`, explicitly restore and verify its user title, preserve model, effort, and working directory, retarget the current VK conversation, and archive the source task. The target can use a selected project or **No project**. |
| `/stop` | Interrupt the active turn. VKodex fixes the exact turn ID, then reads that turn back after a rejection or lost reply and never touches a newer turn. It retries only after an explicit rejection while the same immutable turn is still confirmed running; an unknown result is never replayed blindly. The task is not archived. |
| `/detach` | Disable only VK streaming. The task is neither interrupted nor archived. |

An unknown slash command from the owner opens the relevant help and is not sent to the agent. Messages from other participants, including text starting with `/`, remain ordinary prompts.

Context usage is the latest Codex estimate, not cumulative tokens spent over the task's lifetime. Missing values are not guessed. A deep link is useful on a device with the desktop application installed; the bot cannot modify your phone's clipboard.

**Title synchronization:** renaming through VK saves the title in the Codex catalog and changes the linked conversation to `[VKodex] <title>`. A rename through the standard Codex interface is detected during catalog refresh and copied to VK, including after a bridge restart. Temporary VK failures are retried with backoff, and **Retry for VK** retries immediately. A stale confirmation cannot run the operation twice or overwrite a newer title.

The local Codex API may save a title in the catalog without refreshing an already open window's cache. The bridge reports live-task confirmation separately, never restarts the app, and never sends the title as an agent prompt. Use Codex's native rename action to refresh such a window immediately.

### Messages delivered to VK

Visible commentary is forwarded regardless of whether a turn started in VK, the app, the extension, a goal, or another agent. If its input has not appeared in the stream, the bridge waits at most two seconds to preserve ordering, then releases commentary. This deadline survives restarts and is not extended by new fragments. A later input is labelled as input belonging to that turn; completed answers and old history are not replayed. Explicitly quiet automations retain their notification policy. Health also checks the commentary buffer before the VK delivery queue.

- While a turn is active, the last item in the conversation is a separate silent message such as `thinking... · updated 15:42:20`; it cycles through `thinking..` and `thinking.` and is never appended to agent commentary. After your message, a menu, or a new agent response, VKodex creates a new indicator below and deletes the old one, keeping activity visible in the conversation list without leaving service messages in history. It updates every twenty seconds to avoid VK flood control during long tasks. At completion, the indicator shows `Done.`; errors and lost connections are shown explicitly. Editing stops when streaming is disabled.
- Every agent progress comment is a separate **silent message**. Additional text for the same comment edits that message no more than once every twenty seconds so several active tasks do not trigger VK flood control. Final answers and requested panels are not delayed by this interval.
- A final answer is a separate message with a normal notification and a **Menu** button.
- A user message sent directly from the desktop is mirrored under `## user request` and delivered silently; long prompts repeat the heading in every part.
- A message originating in VK is not echoed back into the same conversation.
- Commands, command output, file changes, tool events, and hidden reasoning are not forwarded.

An automatic link preview does not interfere with text delivery: if the message already contains a URL, the VK card is not treated as a separate file. Request-processing errors are sent to the conversation that originated the request.

Sound and notification display also depend on the VK client and its settings. History from before the first connection is not copied automatically.

If VK rate-limits requests, delivery pauses globally: one second for error `6`, and two minutes for error `9` or `29`. The pause survives a restart, and messages remain queued. Animation and delivery may temporarily stop during the pause.

### Photos and documents

**VK → Codex:** attach a photo or document to a regular message in a linked conversation. You may send attachments without text. A photo reaches the same task as an image; a document is supplied as a local file path. Attachments in replies and forwarded messages are also inspected. If a download fails, the entire request is rejected so the agent does not continue without a required file.

By default, a message may contain up to **10 files**, one inbound file may be up to **200 MiB**, and all attachments in the message may total up to **200 MiB**. Each file is streamed directly to disk instead of being retained in memory; the per-file download timeout is 10 minutes. You may lower these limits through `MAX_INBOUND_FILES`, `MAX_INBOUND_FILE_BYTES`, `MAX_INBOUND_TOTAL_BYTES`, and `DOWNLOAD_TIMEOUT_MS`, but the size ceiling cannot be raised beyond 200 MiB. Video, voice messages, stickers, and other dedicated attachment types are not supported directly yet; send video as a document. Attachments are not accepted by the manager or together with commands such as `/menu`.

**Codex → VK:** every request from a linked conversation gets its own outbox. Ask the agent to save the result there, for example: “Create a CSV and place it in the VKodex delivery folder.” After the turn, the bridge uploads completed files to the same conversation. Images are sent as photos and other files as documents; if VK rejects the photo format, it falls back to a document. Put an image in an archive if you need to preserve exact bytes that VK might compress. `/files` scans the folder manually, including before turn completion.

Inbound files are stored in `BOT_DATA_DIR/files/<request-identifier>/inbox/`; outbound files go to the adjacent `outbox/`. The bridge creates the identifier and gives the exact path to the agent. This is not a project directory. Codex task permissions are not widened: grant access through the regular desktop flow if the task cannot access that folder. Prompts sent directly from the desktop do not receive a new folder automatically.

Each outbox supports up to 10 files, 200 MiB per file, and 200 MiB total. The bridge sends only regular files directly inside `outbox/`: hidden files are skipped, and links or files still being written are rejected. Paths mentioned in answer text and other project directories are never scanned. Archives are not extracted automatically. Document contents remain user data, not bridge commands.

If VK returns `no_free_space` while uploading a document, VKodex can remove the oldest documents previously uploaded by the bridge and retry the same upload. This requires a separate user VK token with document permissions; the community token cannot call `docs.delete`. The token is never written to `.env`, the database, or logs. On Windows, run `npm run vk:token:setup` once from the VKodex directory and paste the token into the hidden prompt. If VK saved the OAuth response to a file, use `npm run vk:token:import -- -InputPath "C:\path\to\vk_auth.txt"`; the importer extracts `access_token` from a VK OAuth URL or JSON response without printing it. It is stored in the DPAPI file `%LOCALAPPDATA%\VKodex\secrets\vk-document-token.xml`; VKodex reads it only after a confirmed storage-full response. Only VKodex-registered uploads are eligible, while current and undelivered attachments are protected. Without this local secret, the bridge reports the required setup instead of retrying indefinitely.

Rescanning and restarting do not resend an unchanged file. Binding activity is checked before download, upload, and delivery, but the participant list is not. Old folders are not sent automatically after a disabled binding is reconnected. Local files remain on disk; move unwanted data to the Recycle Bin manually and never add `BOT_DATA_DIR` to Git.

### Leaving a conversation and disabling a binding

Participant changes do not pause or disable streaming. If the owner leaves, the bridge may continue sending progress and answers to remaining participants. Every participant except the bot itself may continue the task with regular messages. Removing the bot naturally prevents it from delivering messages, but does not act as a detach command.

To stop streaming predictably, the owner must send `/detach` first or disable the binding through the manager. This closes the Codex subscription and cancels outbound items that have not been sent; the Codex task itself continues running. Select the task in the manager again to reconnect. Messages rejected while explicitly detached are not replayed automatically.

Deleting a conversation **only for yourself** does not produce a dedicated event in the [VK community API](https://github.com/VKCOM/vk-api-schema/blob/master/callback/objects.json), so it cannot disable the binding. `/detach` also cannot retract a message that VK already sent or is processing.

<a id="codex-homes"></a>

## 7. Additional Codex data directories

VKodex reads tasks from `~/.codex` by default. For multiple accounts, use `CODEX_SOURCES`: each data directory gets a command owner and an optional launcher for explicit `/open`.

Codex Desktop for the primary account and a dedicated VS Code profile for a work account:

```dotenv
CODEX_SOURCES='[{"home":"~/.codex","owner":"app-server","launcher":{"type":"desktop"}},{"home":"~/.codex-work","owner":"app-server","launcher":{"type":"vscode","executable":"C:/Path/To/Code.exe","userDataDir":"C:/Path/To/Code-Codex-Work"}}]'
```

Three launcher types are supported:

- `desktop` passes `codex://threads/<id>` to the registered Windows protocol handler for Codex Desktop. VKodex does not start `ChatGPT.exe` from `WindowsApps` directly: that path changes across updates and can create separate processes without handing the task to the running application;
- `vscode` starts the configured `Code.exe` with the source `CODEX_HOME`, `userDataDir`, and the official extension's task URI;
- `command` starts a custom executable with an `arguments` array and optional `environment`. Values may use the `{threadId}` and `{codexHome}` placeholders.

`owner: "app-server"` enables a long-lived owner for the selected `CODEX_HOME`. It can continue unloaded tasks without opening a window. If Desktop or VS Code already holds a task's active writer, VKodex recognizes that before mutation and uses the connected client owner. Once dispatch begins, a command is never retried through another owner.

Legacy `CODEX_HOME` and `CODEX_EXTRA_HOMES` remain supported for listing tasks. Without `CODEX_SOURCES`, the primary directory automatically receives the `desktop` launcher; migrate additional directories to the structured format so VKodex can open the correct client explicitly.

These are Codex data directories, not source-code repositories. In the legacy format, the primary directory remains included and duplicate paths are counted once. `CODEX_SOURCES` replaces that entire list: its first entry becomes the primary source, the others are additional sources, and duplicate paths are a configuration error. `~` means the Windows user's home directory. Relative paths are resolved from the launch directory; absolute paths are clearer. In Windows JSON strings, `/` is easier than escaped backslashes.

Restart VKodex after editing the configuration and refresh the task list. Tasks from every readable source are merged by update time. A directory label is shown next to tasks only when valid tasks exist in more than one source; an empty or unreadable extra directory does not add a prefix to the primary list.

`/limits` treats profiles separately. In the manager it reads limits for every configured `CODEX_HOME`; in a task conversation it selects the profile through the saved `sourceId`. With ChatGPT authentication, the **Account** line includes the name when Codex reports it and the sign-in address; API-key authentication shows only the account type. VKodex does not request account tokens or identifiers for display, does not store them in its database, and never commits them to Git.

When an account has an available limit-reset credit, `/limits` shows a **Reset limit** button. In the manager, the button includes the profile label when multiple profiles are configured. Before consuming a credit, VKodex shows the selected profile and account again and requires explicit confirmation. The reset uses the local Codex App Server with a unique idempotency key. If the response is lost, **Check the same request** repeats the operation with the original key, so it cannot consume a second credit. VKodex never applies credits automatically or consumes one while merely refreshing the limits screen.

If an additional CLI or work profile contains tasks but has no desktop project file of its own, VKodex matches tasks to shared local projects by working directory. A project is assigned only when there is one uniquely best root match; other tasks remain under **No project**. Copies with the same ID in different directories stay separate, with independent VK bindings, history sources, and model caches.

For commands and live events on an existing task, the bridge uses its profile owner and verifies `sourceId` before any mutation. The profile App Server attaches an unloaded task itself; an active-writer rejection from a UI client is positive evidence that the task is already open, not a reason to launch a window and wait for 30 seconds. All operations on one owner share the same loaded-task state: VKodex never sends another `thread/resume` during an active turn because that can abort the turn. The ownership cache is discarded and rebuilt after a disconnect. Only `/open` invokes a launcher. A profile or account mismatch, owner loss after dispatch, or incompatible protocol blocks the command; no substitute executor is started. A command with an unknown result is reconciled by immutable operation ID and is never retried automatically.

Start a cross-profile transfer from **Move → Another profile** in the task menu. Transfers run in a background worker with durable SQLite stages, outside the VK button handler. After a VKodex restart, the worker resumes the saved stage with bounded retries and increasing backoff. A UI timeout cannot release a live worker's lease or start a second executor for the same operation.

Before copying, VKodex records the latest terminal turn and the source rollout state. App Server creates a new thread ID in the chosen `CODEX_HOME`, retaining model, reasoning effort and working directory. Paginated history is adapted through a temporary JSONL copy under `<target CODEX_HOME>/.vkodex-transfer-staging`. Before switching the VK conversation, every page of completed history is compared semantically: changed user or agent messages block the transfer, while empty reasoning placeholders that App Server may drop during import are not treated as content. VKodex also checks the copied turn boundary, unchanged source history, native title and project assignment, and a ready live client in the target profile, including **No project** transfers. A project inferred from a workspace path is not proof of native membership. Title and project are checked again after opening the client.

Goals are preserved separately from history. An active source goal is paused, and its copy remains paused to prevent two agents from running it. Resume it with `/goal` after the transfer finishes. The target receives only the **remaining token budget**, not the original full allowance. Codex's API cannot import accumulated usage counters: previous token usage and elapsed time are kept in VKodex's private database and shown separately in `/goal`. Account rate limits are not reset by a transfer.

An acknowledged fork ID is saved before follow-up metadata writes, so retries prepare the same copy. If Codex never acknowledges the result ID, VKodex does not submit another fork or adopt an unrelated descendant as the result. Changes to source history or its goal also stop the switch and preserve both copies for inspection. During preparation, new prompts and modifying commands are rejected with an explanation rather than sent to the old task. **Cancel transfer** releases that restriction once the current stage has settled and before the binding has switched. Cancellation never deletes a created copy or automatically resumes a goal.

After the atomic binding switch, VKodex archives the source through its profile owner. It verifies the persisted source record and saved history boundary, not merely absence from the active task list. Two consecutive live `.codex → .codex-work → .codex` cycles completed without database edits while preserving history, title, an explicit target project, working directory, model/effort, and a paused goal with its budget; both sources were archived. A short turn after returning to `.codex` was confirmed. A `.codex-work` turn was not started because that account had exhausted its usage allowance and remains a separate live check after the limit recovers. A separate crash run intentionally terminated after the binding switch and before archival: a new process resumed the same dead lease, produced exactly one fork, and confirmed archival. An unknown write result is never retried blindly; VKodex first polls native archive state. If source history or goal changes after copying, archival stops and both copies remain available for review. A source held by a UI client without a supported archive channel remains a visible block; VKodex never closes Codex or forcibly removes its writer.

`/health` reports pending transfers, stages without progress, and archived tasks that still have active VK bindings. Legacy records without a saved history boundary are never automatically replayed: missing evidence is not guessed. If a legacy record has a boundary, its source is already archived, and the source's semantic history matches the target's history prefix, VKodex can finish the same stage without a new fork or database edit. If the source acquired another turn, archival retry is blocked even after the VK conversation switched.

Recovery checks use dedicated test tasks: process termination after the fork ID is saved, after opening the target, and after the binding switch; transfer of a paused goal with its remaining budget; and history longer than one page. Separate live processes resumed every saved stage with exactly one fork, the correct VK binding, and confirmed source archival. Native process exit is tracked separately from stdio closure so delayed Windows pipe closure does not turn an acknowledged fork into an error.

Names, projects and goals are read back after writes. A completed goal stays complete; an active goal is paused. For an exhausted budget, the native API requires a positive number, so the target receives a technical minimum of 1 token and a non-running `budgetLimited` status (or `complete` for an achieved goal). No goal is started automatically.

Do not change the primary `CODEX_HOME` or the first `CODEX_SOURCES` entry while reusing an existing VKodex database. Append another directory to `CODEX_SOURCES` (or `CODEX_EXTRA_HOMES` in the legacy format), or create a separate installation with another `BOT_DATA_DIR`. The launcher excludes VKodex secrets from the client process environment. Never edit Codex databases manually to assign a task to a project.

<a id="runtime"></a>

## 8. Continuous operation and VPN routing

VKodex must keep running whenever you want to receive messages. The computer, desktop app, and network must remain available. Sleep, shutdown, or stopping the bridge process interrupts delivery.

### Split routing is required

For stable operation from Russia, routing the entire computer either through a VPN or through a direct connection is insufficient. Configure split tunneling with two routes:

| Traffic | Route |
| --- | --- |
| `VKodex.exe` → VK API, Bots Long Poll, and VK upload servers | `DIRECT`, through a Russian IP |
| Codex desktop traffic to OpenAI | Through the VPN/proxy |

VK may be unstable or unreachable when VKodex is sent through a foreign VPN. Codex tasks may stop starting or continuing if Codex bypasses the VPN on a network where OpenAI is not directly available. Test both routes at the same time: `npm run vk:check` should use the direct connection, while a Codex test turn should use the VPN.

A TUN client with per-application or per-process routing works, for example [v2RayTun](https://github.com/LXST-CODE/v2RayTun). This is only an example of a third-party client; VKodex neither installs nor configures it. Rule names and formats depend on the client version.

First verify a manual launch with `npm run desktop:start`. Then install automatic startup for the current Windows user:

```powershell
npm run service:install
```

The installer registers a `VKodex` Windows Scheduled Task and starts it immediately. A local supervisor relaunches the bridge five seconds after any exit; Task Scheduler additionally restarts the supervisor if it fails and never starts a second instance over a running one. The task runs only in the interactive session of the same user as Codex, while the bridge itself still runs as the stable `%LOCALAPPDATA%\VKodex\runtime\VKodex.exe`. Running as `SYSTEM` is not supported.

The external watchdog records stale health and recovery in `supervisor.log`. A stale report alone never terminates the bridge: forcing it to exit can interrupt active Codex turns. The supervisor restarts the bridge only after the process actually exits. If it is hung, investigate the cause and arrange a controlled restart with active tasks in mind.

VKodex writes the same structured stream to both the console and local `BOT_DATA_DIR/logs/vkodex-<run>.log`; errors and crash stacks use the appropriate level in that same file. Start and exit history is stored separately in `supervisor.log`. Per-run files are not overwritten. This directory lives inside private, Git-ignored `data/`. Review logs before sharing them because third-party messages can include local paths and technical data.

The supervisor window intentionally remains visible with the VKodex logo and the title `VKodex Bridge - DO NOT CLOSE`. Its console belongs to a small locally built `VKodexSupervisor.exe`, so Windows uses the branded icon in the taskbar instead of the PowerShell icon. The window shows a warning, supervisor events, and the live structured VKodex log; the same lines are simultaneously saved to the current run's file. Do not close the window: closing it manually stops both the supervisor and the bridge. If that happens, start the `VKodex` task in Task Scheduler or run `npm run service:install` again.

Inspect it with `Get-ScheduledTask -TaskName VKodex` and `Get-ScheduledTaskInfo -TaskName VKodex`. Run `npm run service:uninstall` to remove it. Reinstall the task after moving the clone so its absolute paths are refreshed.

Do not run the scheduled task and `desktop:start` in a terminal at the same time. Codex must also be running and authenticated after login.

For a controlled bridge update while turns are active, run `npm run service:controlled-restart`. It first writes `data/desktop/restart-intent.json` with only the identities of running tasks, then stops the bridge from an independent worker; the supervisor starts the new process. Startup verifies each task, leaves turns that survived the restart alone, and sends at most one technical continuation prompt to tasks that were actually interrupted. Codex questions are reattached instead of becoming a new turn. The intent remains until recovery finishes, and the durable inbound event journal makes a repeated startup idempotent.

### Dedicated process for TUN rules

On Windows, VKodex commands use a dedicated Node.js copy:

```text
%LOCALAPPDATA%/VKodex/runtime/VKodex.exe
```

Its name and path do not change with the repository path or system Node.js version. Route this process to `DIRECT` in v2RayTun, sing-box, or another TUN client. Prefer a full-path rule when supported. `VKodexSupervisor.exe` only manages local processes and does not contact VK or OpenAI, so it needs no routing rule.

This exclusion is for VKodex, not every `node.exe` process and not Codex itself. Do not route Codex directly: its OpenAI access must stay on the VPN route. VKodex does not modify VPN settings.

`desktop:dev`, `desktop:start`, `desktop:probe`, and `vk:check` use this runtime automatically. The ID-resolution command above uses it as well.

<a id="maintenance"></a>

## 9. Updates and backups

### Updating the source

1. Stop VKodex normally. You do not need to stop an active Codex task to update the bridge.
2. Back up the configuration and data.
3. Check `git status`. Preserve or reconcile your own changes before updating; do not force-reset them.
4. Run these commands in the repository:

```powershell
git pull --ff-only
npm ci
npm run check
npm run vk:check
npm run desktop:start
```

### Health check

Profile App Server diagnostics use only `thread/read`: inspecting a task does not issue `thread/resume` or change the live observer's subscription. A `notLoaded`, unknown, or missing runtime status does not confirm a working connection. A mutating request timeout leaves that operation's outcome unknown, but no longer terminates the shared App Server by itself: unrelated tasks and notifications remain connected. Do not blindly repeat such a command; a timeout does not prove Codex rejected it.

Local observers of one task share one upstream subscription: closing one observer does not unsubscribe the others. Reconnection waits for the previous `unsubscribe`; an unknown result does not authorize a blind `resume`. A VK input waits for its own task's connection rather than every background connection. Closing a terminal subscription no longer waits for final-answer delivery to VK: the persisted delivery queue proceeds independently. This is not proof of writer handoff to another client.

If local initialization fails after Codex confirms a subscription, VKodex still attempts to unsubscribe that task without closing the shared server. A late resume response from a disconnected connection cannot publish a new ownership claim or initial state.

Prompt input is saved to the durable inbox before waiting for its own task connection. That wait does not depend on background history scans, panel refreshes, or catalog reads. A failed connection or a changed binding rejects the prompt before dispatch; local recovery commands such as `/detach` remain available. Late catalog and history results cannot replace the newly attached stream or its observation checkpoint. Clearing a history reader also invalidates any read still in flight.

Background observation is also task-scoped: a slow history read, task-creation inspection, or panel refresh does not hold the global connection loop. A pending job is not started again on every tick. Health reports the delayed stage and its age (`history`, `catalog`, `creator-inspect`, `panels`) even while the scheduler timer is healthy. Background discovery of disconnected tasks still needs the shared catalog; that wait does not block maintenance of existing subscriptions.

Within one App Server connection, replaying an identical unresolved server request does not invoke its question/tool handler again. Conflicting payloads for the same pending RPC ID are rejected without closing other tasks; a late handler response cannot cross into a new connection. This protection covers pending requests only, not durable recovery of completed operations.

Unsubscribing an observer does not discard a pending Codex question: the task can keep running without a subscriber. A question is retired when answered, replaced, when task unload is confirmed, or when its connection is lost. Answer dispatch rechecks that preparation has not raced with a replacement; one failing question observer does not block the others.

The IPC client also accepts an explicitly supplied inbound native request handler for Gateway testing. By default it declines discovery and does not claim task ownership. This interface alone neither enables managed workers nor proves native UI compatibility.

Incoming IPC broadcasts are accepted when addressed to this client or when no recipient list is supplied: native clients use the latter to announce observation when opening a task. Foreign, empty, and malformed recipient lists are ignored; state handlers additionally validate the owner, source directory, and task.

Observers of the same native task within one IPC transport also share one subscription. Only the last observer closes the upstream follow; each receives its own state copy. Conflicting copies of one task from different source directories are not combined.

At startup and then every `HEALTH_CHECK_INTERVAL_MS`, VKodex checks the complete operating chain:

- SQLite integrity through `PRAGMA quick_check`;
- the one-second runtime loop and current refresh duration;
- size and age of the important VK queue (answers and panels), separately from background progress (comments and indicator), plus any rate-limit pause;
- local Bots Long Poll, token permissions, event configuration, and Long Poll server availability;
- readability of every configured `CODEX_HOME`;
- availability of attached task workspaces, so a renamed or removed directory cannot look like a healthy Codex connection;
- safe goal-state reads through the local Codex API without exposing the objective in the health report;
- the number of connected active streams;
- Codex task system errors, including account usage limits: these result in `DEGRADED` even when VK and IPC work;
- the Codex named pipe and stream protocol v11 compatibility. A full protocol canary runs at startup, manually through `/health`, and at least once every ten minutes.

Each live task connection is also checked in the background every 30 seconds. If the profile App Server restarts, the bridge reconnects without opening a window or resubmitting a prompt, and events from an obsolete generation are ignored. If the owner is missing, the thinking indicator stops. `/menu` remains available offline; its “Open in Codex” button or `/open` explicitly opens the task through the selected source launcher. A `systemError` is not treated as an active turn even if restored history contains an old `inProgress` entry. When an account hits its usage limit, the bot points to `/limits` instead of continuing the animation.

The latest report is stored without tokens or message content in `BOT_DATA_DIR/health.json`. Current process state and the reason for a handled exit are stored without configuration or error text in `BOT_DATA_DIR/runtime-process.json`. The following command checks health report freshness and exits nonzero if the bridge stopped, the report is stale, or its state is not `OK`:

```powershell
npm run health:check
```

An in-process check cannot send a warning after its own process has died, so a persistent installation needs `service:install` or another external supervisor. `FAILED` is sent to the manager after two consecutive checks; `DEGRADED` is sent only after ten consecutive checks. `health check is OK again` is sent after three successful checks, so a brief VK pause does not create a cascade of alerts. If VK itself is unavailable, the warning remains in the durable queue and is delivered after recovery.

`DEGRADED` means core work may continue but part of the chain is unconfirmed: for example, no task is available for the protocol canary, an active task lost its owner, VK imposed a temporary pause, the last delivery failed, or an important queue item has not cleared for more than 30 seconds. A pending background comment edit or `thinking` update without a delivery error does not degrade health or raise it to `FAILED`. Closed and idle tasks do not need a live subscription and do not degrade health by themselves. The profile App Server reconnects an unloaded task without focusing a window; `/open` is only for explicitly showing it. `FAILED` means a mandatory check failed or the same important answer or panel has been delayed for more than five minutes. After a Codex update, also run `desktop:probe`, `/health`, and a test turn in a separate task. Never edit a protocol version manually to bypass adapter rejection.

### What to back up

With the bridge stopped, copy these items to secure storage:

- `.env`;
- the entire `BOT_DATA_DIR`, including `vkodex.sqlite` and any `-wal` or `-shm` files.

The database contains conversation bindings, the delivery queue, and processed-event records. Do not delete it during a regular update: losing it may create duplicate VK conversations. A VKodex backup does not replace backups of source projects and Codex data.

The database belongs to the configured owner and community. Use a separate data directory for another account or community; never reuse someone else's database.

### Updating Node.js

The private `VKodex.exe` is not replaced automatically. When updating it:

1. Stop VKodex.
2. Install a supported Node.js version.
3. Move **only the private `VKodex.exe`** from the runtime directory to the Recycle Bin.
4. Run `npm ci`, `npm run runtime:prepare`, and `npm run check`.
5. Start the bridge again.

Startup is blocked if native modules have a mismatched architecture or ABI. Do not remove `.env`, VKodex data, or Codex directories together with the runtime.

<a id="troubleshooting"></a>

## 10. Troubleshooting

| Symptom | What to check |
| --- | --- |
| The bot never replies | Look for `VK Long Poll started`; check the token, community ID, exactly **one** `VK_OWNER_ID`, and permission to receive community messages. Run `npm run vk:check`. |
| Text works but buttons do not | Enable the `message_event` event and set Long Poll API version to `5.199`. |
| A VK edit does not reach Codex | Enable `message_edit`, and verify that this is the same author's latest message and that it started a standalone live turn. A steer sent while the agent was already working cannot be rewritten safely. |
| The catalog contains no tasks | Make sure Codex runs under the same user, check `CODEX_HOME` and extra directories, and inspect `desktop:probe`. Archived and internal tasks are excluded. |
| A task is listed but cannot be linked | Codex and VKodex must run as the same OS user. Check `owner: "app-server"`, the source `home`, account, and source selection in `CODEX_SOURCES`. `notLoaded` means the UI unloaded the task; the profile owner should reconnect it without a launcher. If Desktop/VS Code already holds it, that client's active-writer channel must be available. A confirmed pre-dispatch rejection appears in health as `codex_route`; the bridge safely retries the connection in the background but never replays the rejected prompt. For duplicate IDs, also check `sourceId` and the history path. |
| No conversation invite arrived | Open the manager. After creating a conversation, the bot sends a link whether or not VK added the owner automatically. Join through it; there is no confirmation button. Check that the bot may participate in conversations. |
| It is unclear whether a conversation or command was created | Inspect VK and Codex manually. The bridge intentionally avoids repeating actions after ambiguous responses. Do not clear the database just to retry. |
| An old participant-check pause remains after updating | Restart the bridge. A stale pause created by the former participant check is cleared automatically. If the binding was explicitly disabled before, select the task in the manager again. |
| Leaving a conversation did not stop streaming | This is expected. Participant membership is not access control. Send `/detach` or disable the binding in the manager before leaving. |
| A steer or next turn was not sent | `notLoaded` after a completed turn is not a block: the bridge starts the next turn in the same task and preserves context. Real blockers include an active turn, a Codex question or approval, a source mismatch, and loss of the IPC owner. A lost response does not make a request safe to retry; inspect the desktop result first. |
| Codex is waiting for permission | Respond in the desktop app. Approval controls are not available through VK yet. Do not disable safeguards merely to use the bridge. |
| A final answer is missing | Check whether the Codex turn finished, the binding is active, and VK is available. The queue resumes after recovery, but history before the first connection is not replayed in full. |
| Models are unavailable | Open model selection in Codex and refresh its cache. The adapter rejects a cache older than one day. |
| A photo or document did not reach Codex | Send it to a linked task conversation, not the manager. Check limits, access to VK download servers, and task permission for the local file directory. |
| A completed file did not reach VK | Save it in the exact `outbox/` included in the request and send `/files`. Other project directories and files from unconfirmed requests are not scanned. |
| `npm.ps1 cannot be loaded` | Call `npm.cmd` instead, for example `npm.cmd ci`. Do not change the global execution policy without understanding the impact. |
| `better-sqlite3` fails to load or the runtime is incompatible | Check Node.js version and architecture, reinstall with `npm ci`, then refresh the private runtime as described above. |
| VK fails through the VPN | Configure split tunneling: full `VKodex.exe` path through a Russian IP (`DIRECT`), Codex/OpenAI through the VPN. Repeat `vk:check`; do not exclude every `node.exe`. |

When reporting an error, include Windows, Node.js, Codex, and VKodex revisions, the launch command, and a sanitized error message. Do not attach a populated configuration, database, tokens, personal VK ID, or private conversation.

<a id="security"></a>

## 11. Security and limitations

The private VKodex manager is designed for **one owner**. Its menus and state-changing buttons in linked conversations are available only to `VK_OWNER_ID`.

A linked task conversation is intentionally a shared prompt surface. The bridge does not read or validate its participant list: **every incoming message not authored by the community itself becomes a Codex request**, including text and supported attachments from another participant. Such a participant can influence the task, files, and working directory through agent instructions, and can see progress, answers, and outbound files. Owner-only buttons do not protect against regular text prompts. Do not add anyone whom you do not trust to control that task.

Forwarded text is stored in VK and the bridge's private database; attachments are stored in VK and the local file directory. Do not link tasks containing data that cannot be shared with every participant in the selected conversation. Conversation membership is not a security boundary.

`.env`, `data/`, SQLite databases, and logs are excluded from Git. If you set a custom `BOT_DATA_DIR` inside the repository, exclude the entire directory in `.git/info/exclude` and inspect `git status`. A `.gitignore` cannot protect a secret that has already reached a commit or screenshot.

### Features not yet available in the desktop adapter

| Feature | Current behavior |
| --- | --- |
| Approvals and questions with multiple-choice answers | Handle them in the desktop app. |
| Other media types | Photos and documents are accepted; send video, voice messages, and other formats as documents. |
| Public **Share** URL | Create it directly in Codex. |
| Remote or cloud Codex control | This guide and adapter target a local desktop installation. |

VKodex never edits Codex data directories directly. Each `CODEX_HOME` with `owner: "app-server"` uses a separate long-lived `codex app-server --stdio` connection, so equal thread IDs in separate profiles are not mixed. Creation remains an atomic first-turn boundary; afterward the profile owner handles continuation, interruption, the native queue, questions, model settings, goals, and events. If Desktop or VS Code already holds the task, active-writer ownership is classified before mutation and the command routes to that connected client. An incompatible protocol or uncertain result blocks mutation instead of starting a substitute executor.

<a id="legacy-sdk"></a>

## 12. Legacy Codex SDK mode

<details>
<summary>Separate mode: starts its own sessions and does not control tasks open in the desktop app</summary>

This prototype remains in the repository for development. Its `npm run dev` and `npm start` commands are not aliases for `desktop:dev` and `desktop:start`. Do not run both modes with the same community or database.

SDK mode needs `VK_GROUP_TOKEN`, `VK_GROUP_ID`, `VK_OWNER_IDS`, `VK_ALLOWED_USER_IDS`, `WORKSPACE_ROOTS`, and either Codex CLI authentication or `OPENAI_API_KEY`. The owner must be included in the allowed-user list. Every `WORKSPACE_ROOTS` directory must exist; never keep `.env` inside a working directory exposed to the agent.

```powershell
npm run dev
```

For the compiled version:

```powershell
npm run build
npm start
```

Start with `/bootstrap` in the private chat. Then create a session with `/new my-repository | Task title`; the directory must be within `WORKSPACE_ROOTS`.

| Command | SDK-mode action |
| --- | --- |
| `/bootstrap` | Try to create a shared manager conversation. |
| `/new <workspace> \| <title>` | Create a standalone Codex session. |
| `/list`, `/use <id>` | List sessions and select one in the manager chat. |
| `/status` | Show status. |
| `/stop`, `/close` | Stop a turn or archive a session in its separate conversation. |
| `/help` | Show command help. |

`VK_CONVERSATION_MODE=managed` requires separate conversations, `single` selects sessions in one manager chat, and `auto` attempts to create a conversation before falling back to the shared chat. `/stop` and `/close` are unavailable in `single` mode.

Files arrive in `.vkcodex/inbox/<turn-id>/` and are sent from `.vkcodex/outbox/<turn-id>/` inside the working directory. Archives are not extracted. File limits and other settings are documented in [.env.example](.env.example).

This is not participant isolation: allowed manager participants can select shared sessions. Interactive approvals through VK are not implemented. Variables from `CODEX_ENV_ALLOWLIST` are exposed to the agent process; do not add secrets without a specific need.

A real-community test is documented in the [SDK smoke test](docs/SMOKE_TEST_RU.md). The Docker configuration applies only to this mode.

</details>

<a id="development"></a>

## 13. Development and license

```powershell
npm run typecheck
npm test
npm run build
```

Run all three with `npm run check`. Automated tests use VK and Codex test doubles; they do not message real users. Validate the live integration separately with your own community and a test task.

- [CONTRIBUTING.md](CONTRIBUTING.md) — development and pull-request workflow.
- [Architecture](docs/ARCHITECTURE.md) — components and state storage.
- [Issues](https://github.com/RedRatInHat/VKodex/issues) — report bugs and feature requests without private data.
- [MIT License](LICENSE).

VKodex is an independent project and is not an official VK or OpenAI product.

### Deferred prompts: `/queue`

Send `/queue <prompt>` in a task conversation (newlines and attachments are supported). VKodex calls `thread/queue/add` to append to the **native Codex queue**, without steering the current turn. Codex may start it immediately when idle. Codex owns persistence and execution; VKodex has no separate queue scheduler. The task client must be connected. An uncertain insertion is never retried automatically. Edit an already queued prompt in Codex.

### Codex questions in VK: `/questions`

An open Codex question appears in the task conversation with option buttons and **“Свой ответ”** (custom answer). You can also use VK's **Reply** on the question card and type your answer. Multiple questions are collected in order and submitted together. `/questions` checks current questions and refreshes buttons, which expire after 30 minutes.

Both blocking `item/tool/requestUserInput` requests and asynchronous `request_user_input_async` questions are supported. Async answers use the same structured reply envelope through `steer` as the Codex client. An async question does not imply that the agent has stopped working; it is no longer answerable once its turn ends.

Only the VKodex owner can answer, including in shared conversations. Secret fields (`isSecret`) must be answered in Codex. Command/file permission approvals and MCP forms are not handled by this feature. Answers never start a new turn or enter `/queue`.

The task-owning client must provide live state; reading the rollout file alone is insufficient. VKodex rechecks the question and selected source before submitting. Answering in the app closes the VK card. Open questions survive bridge restarts without replaying answers. Ambiguous submissions remain blocked pending verification in Codex. Editing an already submitted answer from VK is not supported yet.
