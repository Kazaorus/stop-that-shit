# Architecture

Stop That Shit has a host-independent control core, five thin host adapters,
and a metadata-only runtime evidence sidecar.

```text
Codex Hook JSON       ----> Codex Adapter --------\
Claude Hook JSON      ----> Claude Adapter --------+--> ControlEvent v1
OpenCode hooks        ----> OpenCode Adapter -----+          |
Hermes native Plugin ----> Hermes CLI Adapter ----+          v
Pi Extension          ----> Pi Adapter -----------/  decision(contract, action)
                                                               |
                                  +----------------------------+------------------+
                                  v                                               v
                           host response                                  RuntimeEvent v1
```

- `src/decision.cjs` contains host-independent decisions.
- `src/contracts.cjs` parses the small prompt contract.
- `src/controller.cjs` stores the current contract and applies decisions.
- `src/adapters/codex-*.cjs` classify Codex events and render Codex responses.
- `src/adapters/claude-*.cjs` classify Claude Code events and render Claude Hook
  responses.
- `src/adapters/opencode-*.cjs` classify OpenCode messages and tool calls.
- `src/adapters/hermes-*.cjs` classify Hermes payloads and render Hermes
  responses; the installed bundle is `.hermes-plugin/runtime/stop-that-shit.cjs`.
- `src/adapters/pi-*.cjs` classify Pi Extension events and render Pi block or
  context results.
- `opencode/stop-that-shit.mjs` bridges the in-process OpenCode plugin hooks.
- `.hermes-plugin/__init__.py` is the only Hermes host entrypoint and bridges
  native Plugin callbacks to the bundled runtime.
- `pi/stop-that-shit.ts` is the Pi package entrypoint.
- `src/state.cjs` stores schema-2 per-session contract state and serializes the
  delegation ledger so concurrent Hook processes cannot oversubscribe either
  agent limit.
- `src/delegation-state.cjs` owns pure reservation transitions. Total usage is
  consumed by `action.before`; active reservation units are released by
  `action.after`, `subagent.stop`, or `session.end`. The ledger also keeps
  session-local agent IDs already seen by lifecycle events so delayed duplicate
  starts cannot bind a later reservation; this metadata is not active usage or
  runtime audit data.
- `src/runtime-audit.cjs` appends and reads metadata-only decision events.
- `src/runtime-annotations.cjs` appends independent human labels.

## Host event boundaries

Codex maps `UserPromptSubmit` to `prompt.submit`, `PreToolUse` to
`action.before`, `SubagentStart`/`SubagentStop` to the matching lifecycle
events, `PostToolUse` to `action.after`, and `SessionEnd` to `session.end`.
Claude Code uses the same lifecycle mapping with its `Agent` tool's
`tool_use_id` and `agent_id`; `UserPromptExpansion` remains an optional prompt
surface. Prompt-capable hosts return a native prompt block for invalid legacy
or malformed directives, while the controller also records the error and
rejects later delegation until a valid directive arrives.

Hermes native Plugin maps the following lifecycle events:

```text
pre_llm_call  -> prompt.submit  -> {"context":"..."} when context is returned
pre_tool_call -> action.before  -> {"action":"block","message":"..."} on denial
post_tool_call -> action.after
subagent_start/subagent_stop -> subagent.start/subagent.stop
on_session_end -> session.end
```

The explicit Hermes tool table
covers `write_file`, `patch`, `delegate_task`, `read_file`, `search_files`,
`web_search`, `web_extract`, `vision_analyze`, `clarify`, and `todo`. `terminal`
reuses the existing shell classifier. `execute_code`, browser/computer-use,
memory, cron, Skill management, message sending, and all other unlisted
built-in/plugin/MCP tools remain `unknown`; an armed contract blocks unknown
mutability rather than guessing.

A Hermes `delegate_task` call reserves the total and concurrent limits by the
number of child agents it can start: one for a non-empty `goal`, or
`tasks.length` for a batch. The complete count is checked and reserved
atomically before the tool runs; an insufficient limit rejects the whole batch
without consuming any units. Completion events release active units but never
refund the cumulative total.
`action=list`, `action=steer`, and `action=stop` are control operations and
consume zero budget units.

The OpenCode plugin can load from a local file or GitHub package and uses only
documented hooks: `message.part.updated` and session events through `event`, plus
`tool.execute.before` and `tool.execute.after`. It recovers user messages with
the SDK `client.session.message` call, injects contract context with
`client.session.prompt({ noReply: true })`, and maps child sessions to the root
contract so a subagent cannot silently replace user authority.

Pi maps `input`, `before_agent_start`, `tool_call`, and `tool_result`. The first
two arm and inject the shared contract; `tool_call` is the deny-capable boundary;
`tool_result` carries observation-only context without blocking. Mid-turn
contract switches are not applied to the active turn. The optional official
`subagent` tool is budgeted at its parent call, while cross-process contract
inheritance remains outside the supported boundary.

## Control and evidence boundaries

Control state and observed response remain deliberately separate:

```text
OFF        no checks and no normal-action events
OBSERVING  check and record; never return permission deny
ARMED      explicit task contract; may return permission deny

response: none | context_returned | permission_deny_returned | execution_denial_returned
host effect: unobserved
```

Installation defaults to `OBSERVING / unconfirmed`. An explicit task mode arms
the Guard; `watch` stays observing and `off` stops normal-action recording.

Hard decisions are limited to observable facts:

- writes in a confirmed non-mutating mode;
- writes outside an optional explicit `files=` list;
- covered dependency additions without authority;
- subagent launches beyond `total-agents=N` or `concurrent-agents=N`;
- high-confidence hashing without `hash=allow`.

Every observing or armed check is recorded even when the policy allows it, so
runtime totals retain a real checked-action denominator. Audit write failures
fail open and never change the control decision. The Skill handles broader
semantic judgment through the Stop Ladder. All adapters are guardrails, not
security sandboxes: specialized tool paths may bypass Hooks, and a deny
response does not prove the host prevented execution. Runtime `hostEffect`
remains `unobserved`.

## Hermes support matrix

| Surface | Status | Evidence boundary |
| --- | --- | --- |
| Hermes CLI + native Plugin | Supported and tested offline | Plugin package, adapter/controller, runtime, and concurrency fixtures. |
| Hermes Gateway | Reload after lifecycle changes | Run `hermes gateway restart` after enabling, disabling, updating, rolling back, or reinstalling the plugin. |
| cron, Kanban worker, ACP, Desktop, or non-dispatcher paths | Not supported or declared | No matching adapter contract or test. |

The Gateway restart is required after plugin lifecycle changes, not on every use.
