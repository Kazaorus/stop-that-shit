# Host Adapter Contract

Stop That Shit has five implemented host adapters: Codex, Claude Code,
OpenCode, the Hermes Agent CLI native Plugin adapter, and Pi. Each adapter translates
host input into the same `ControlEvent v1` and reuses the same contract parser,
controller, decisions, state, and runtime evidence.

An Adapter may reuse the decision module only if its host exposes:

1. a stable session identifier;
2. user prompts or explicit mode changes;
3. a before-action event that can actually deny an action;
4. tool name, input, and enough information to classify mutability.

Lifecycle context injection is host-specific, but all five adapters map
available lifecycle signals to the shared protocol. `action.before` reserves a
delegation batch atomically. An `action.after` releases active units only when
the host explicitly confirms synchronous completion; background or unknown-status
work remains reserved until `subagent.stop` or `session.end`. Adapters require
explicit host identifiers and never pair reservations by event arrival order.

The normalized event is versioned as `ControlEvent v1`:

```json
{
  "protocolVersion": 1,
  "kind": "action.before",
  "sessionId": "opaque",
  "action": {
    "name": "Edit",
    "mutability": "write",
    "affectedPaths": ["src/config.cjs"],
    "dependencyIntent": false,
    "hashIntent": false
  }
}
```

## Codex mapping

`src/adapters/codex-hooks.cjs` maps the existing Codex Hook JSON to
`ControlEvent v1`. The preserved Codex manifest points at
`hooks/codex-hooks.json`, so Claude support does not broaden the original Codex
Hook trust surface.

## Claude Code mapping

`src/adapters/claude-hooks.cjs` maps:

```text
SessionStart         -> session.start
UserPromptSubmit     -> prompt.submit (also the /stop-that-shit:stop-that-shit slash form)
PreToolUse            -> action.before
SubagentStart         -> subagent.start
SubagentStop          -> subagent.stop
PostToolUse           -> action.after (by tool_use_id)
SessionEnd            -> session.end
UserPromptExpansion  -> prompt.submit (Stop That Shit Skill only; optional on hosts that expose it)
```

The Claude adapter returns a `PreToolUse` `permissionDecision: "deny"` when the
shared controller denies an action. `agents=N` is enforced before a Claude
`Agent` tool runs; the
started subagent binds by an explicit `reservation_id`, and `agent_id` is used
for stop events. A `PostToolUse` event releases activity only when its payload
confirms synchronous completion; otherwise the reservation remains active.

The classifier covers Claude-native `Write`, `Edit`, `NotebookEdit`,
`EnterWorktree`, `Bash`, `PowerShell`, `Monitor`, `Agent`, current read tools,
and control/task tools. `Monitor` command sources reuse shell dependency/hash
classification; WebSocket monitors are read-only. `Workflow` is treated as
unbounded delegation and is denied by an armed Guard because its internal
subagent fan-out cannot be proven to satisfy the configured agent limits.
MCP/plugin tool names
fall back to the existing conservative name classifier. Explicit file locks
normalize POSIX and Windows absolute paths relative to Hook `cwd` when possible.

## OpenCode mapping

The OpenCode plugin uses the documented plugin surface only: the `event` hook
(`message.part.updated` plus `session.created`/`session.updated`/
`session.deleted`), `tool.execute.before`, and `tool.execute.after`. It does not
use the undocumented `chat.message` hook.

User text is recovered from a `message.part.updated` trigger through the
documented SDK call `client.session.message`, mapped to `prompt.submit`, and
`tool.execute.before` is mapped to `action.before`. A denied action throws
before the tool runs and records `execution_denial_returned`; Codex continues to
record `permission_deny_returned`. Watch-only context is appended to a
successful tool result through `tool.execute.after`.

Contract context is injected with the documented SDK call
`client.session.prompt({ noReply: true })` carrying a synthetic text part.
Synthetic and ignored parts never arm or change the contract, so injected
messages cannot feed back into contract parsing. Per-session processing is
serialized, and `tool.execute.before` waits for in-flight message processing
before it evaluates the contract.

An explicit host mode switch is treated as authorization. When a root-session
user message that is not a `$stop-that-shit` directive arrives under an
edit-capable agent (resolved through `client.app.agents()`; unknown agents fail
open) while the contract is `review`, the plugin advances the contract to
`change` with `source: host`, preserving file, dependency, and hash settings.
Explicit directives always win, read-only agents never advance, subagent
messages never advance the root contract, and the host permission layer
continues to apply independently.

OpenCode creates a new session identifier for each `task` subagent. The plugin
maps child sessions to the root session contract. A task
`tool.execute.before` reserves its child count and `tool.execute.after` emits
`action.after` with the tool's explicit action ID and async status; a terminal
child session update or documented `session.idle`/idle `session.status` event
emits `subagent.stop` when the child was explicitly associated. Deleting the
root session emits `session.end`, while deleting a child never clears the root
reservation. The plugin does not parse child
prompts as new user authority and treats a `task_id` continuation as control
rather than a new delegation. If ancestry cannot be resolved, it fails open
without treating the uncertain child prompt as user authority.

## Hermes Agent CLI

The Hermes adapter is implemented in `src/adapters/hermes-hooks.cjs` and
classifies tools in `src/adapters/hermes-tool-classifier.cjs`. The native Plugin
maps this deliberately small event surface:

```text
Hermes pre_llm_call  -> prompt.submit
Hermes pre_tool_call -> action.before
Hermes post_tool_call -> action.after
Hermes subagent_start/subagent_stop -> subagent.start/subagent.stop
Hermes on_session_end -> session.end
```

`pre_llm_call` maps `session_id` to `sessionId`,
`extra.user_message` to `prompt`, and `extra.turn_id` (or the available
top-level turn id) to `turnId`. A context result is rendered as
`{"context":"..."}`.

`pre_tool_call` maps the top-level `tool_name`, `tool_input`, `session_id`, and
`cwd` to `action.before`. A denied action is rendered as
`{"action":"block","message":"..."}`. Unknown events, empty payloads, and
non-applicable allow results produce no stdout and exit successfully.

The adapter reserves the complete `delegate_task` child count at
`pre_tool_call`; lifecycle events bind and release the shared reservation. If
Hermes does not identify a call as synchronous, the reservation is retained
until an explicit `subagent_stop` or `on_session_end` event.

### Explicit Hermes tool coverage

The first version uses an explicit, conservative table. An unlisted tool is not
silently promoted to a safe class merely because its name or input contains a
path.

| Class | Explicit coverage | Behavior |
| --- | --- | --- |
| `write` | `write_file`, `patch` | Extracts real targets for file locks; missing targets remain unproven. |
| `delegate` | `delegate_task` with one `goal` or a `tasks` batch | Reserves the number of child agents that will be started: one for `goal`, or `tasks.length` for a batch. The complete count is checked and reserved atomically before the tool runs. |
| `read` | `read_file`, `search_files`, `web_search`, `web_extract`, `vision_analyze` | Known read-only allowlist. |
| `control` | `clarify`, `todo`, and `delegate_task` with `action=list`, `action=steer`, or `action=stop` | Control operations; do not reserve agent-limit units and are not repository writes. |
| shell-derived | `terminal` | Reuses the existing shell classifier: explicit reads are `read`, explicit writes are `write`, and unproven commands are `unknown`. |
| `unknown` | `execute_code`, browser/computer-use, memory, cron, Skill management, message sending, and every unlisted built-in, plugin, or MCP tool | Fail open before an explicit contract; under `review`/`answer`/`monitor`, block as `MUTABILITY_UNPROVEN`. |

`write_file` and `patch` provide affected paths from their actual input. V4A
patches include every Create/Update/Delete/Move target. Paths are normalized
relative to Hook `cwd` with POSIX and Windows absolute-path handling. The
adapter reuses the existing dependency/hash detectors and does not duplicate
core mode, hash, dependency, file-lock, or agent-budget decisions.

A Hermes `delegate_task` call containing `tasks=[...]` is charged by the actual
child count: one for a non-empty `goal`, or `tasks.length` for a batch. The
complete batch is checked against the active agent limit before execution; only
confirmed synchronous completion releases active slots.

## Pi

The Pi package entrypoint is `pi/stop-that-shit.ts`. It is tested against
`@earendil-works/pi-coding-agent` `0.84.4` and maps this extension surface:

```text
input               -> prompt.submit
before_agent_start  -> contract context message
tool_call            -> action.before -> { block: true, reason } on denial
tool_result          -> action.after plus watch-only context appended to the tool result
session_shutdown     -> session.end
```

The Adapter takes the stable session ID from Pi's session manager, preserves
`toolCallId` as the action ID, and maps `cwd`, structured tool input, `mode`
(`tui`, `rpc`, `json`, or `print`), and `hasUI` into the shared event. The same
decision path is used in UI and headless modes; notifications are UI-only.

`input` accepts both `$stop-that-shit` and Pi's native
`/skill:stop-that-shit` form. Input whose source is `extension` never creates
user authority. Pi can receive queued input while an Agent turn is streaming;
contract changes in that state are handled without changing the active
contract and must be submitted again after Pi is idle.

The explicit Pi table covers `read`, `grep`, `find`, `ls`, `write`, `edit`,
`bash`, and `powershell`. Every unlisted custom or package tool remains
`unknown`. The optional official `subagent` example is recognized only through
its documented single, `tasks`, and `chain` input shapes. The parent tool call
reserves the complete count atomically. Pi retains the pending reservation by
`toolCallId` until `tool_result` emits `action.after`; an explicit background or
unknown-status result remains active because the current Pi extension API does
not expose a child-specific stop event, and `session_shutdown` is the cleanup
boundary. Separate child Pi processes do not inherit the parent contract through
a proven standard ancestry channel.
Pi's user-initiated `!` and `!!` shell paths are outside the Agent `tool_call`
surface.

Pi operational adapter errors are caught so they retain the shared fail-open
behavior. Only a shared policy denial returns Pi's `block`; `terminate` is
omitted so the Agent can recover with an in-scope action.

## Support matrix and evidence boundary

| Hermes surface | Status | Evidence and boundary |
| --- | --- | --- |
| Hermes CLI + native Plugin | Supported and tested offline | Real Hermes envelopes, adapter/controller cases, lifecycle entrypoint tests, and parallel active-reservation tests. |
| Hermes Gateway | Reload after lifecycle changes | Run `hermes gateway restart` after enabling, disabling, updating, rolling back, or reinstalling the plugin; it is not required on every use. |
| cron, Kanban worker, ACP, Desktop, or paths bypassing the standard tool dispatcher | Not supported or declared | No adapter contract or matching test exists for these surfaces. |

Host-specific event names, tool classification, paths, and response JSON belong
inside the Adapter. Model identity is evaluation metadata, not a new Adapter.
The Adapter may report that it returned context or a host-specific denial, but it
must not claim that the host prevented execution through every other path.
`RuntimeEvent v1` therefore records `hostEffect` as `unobserved`.

All five adapters are guardrails, not sandboxes. Specialized tool paths can
bypass normal Hooks, and a returned `permission_deny_returned` or Hermes block
response is evidence of the adapter response—not proof that the host ultimately
did not execute the action.
