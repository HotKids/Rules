---
name: Surge
description: Operate and troubleshoot Surge via surge-cli, including command discovery, runtime diagnostics, state inspection (dump/watch/test), and environment mutation with set key-paths. Use when a task asks to control Surge behavior, inspect live status, adjust policy/runtime switches, or automate Surge operations from CLI.
---

# Surge CLI Ops

Use this skill to run Surge operations safely and consistently through `surge-cli`.

## Startup

1. Resolve executable path in this order:
   - `surge-cli` in `PATH`
   - `/Applications/Surge.app/Contents/Applications/surge-cli`
2. Prefer JSON output with `--raw` for machine parsing.
3. If operating on remote instances, add `--remote password@host:port`.

## Baseline Context Workflow

Before mutating runtime settings, collect baseline state:

1. `surge-cli --raw environment`
2. `surge-cli --raw dump policy`
3. `surge-cli --raw dump profile`

After changes, re-run the relevant read commands to verify effects.

## Mutation Rules

When using `set`:

1. Use minimal key-path deltas only.
2. Batch related updates in one command when possible.
3. Treat `<nil>` and `(null)` as null assignments.
4. Re-check `environment` immediately after mutation.

Examples:

```bash
surge-cli --raw set ProxyMode=2
surge-cli --raw set ProxyGroupSelection.Proxy=HK
surge-cli --raw set AutoPolicyGroupOverride.Streaming=<nil>
```

## Streaming Command Handling

For streaming commands (for example diagnostics/bandwidth tests):

1. Process incremental chunks.
2. Respect completion markers (`hasMore=false` or command-specific completion payload).
3. Do not assume a single response frame.

## Platform and Capability Notes

1. Some commands are platform-limited (for example certain device-management and profile-edit commands).
2. Validate capability and platform before execution in automation workflows.

## Reference

Read detailed command semantics, full command list, and environment key definitions from:

- [Command Reference](references/command-reference.md)
