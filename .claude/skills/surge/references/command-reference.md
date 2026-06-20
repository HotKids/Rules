# Surge CLI / Controller Command Reference (for AI Agents)

This document provides a complete operational reference for AI agents, including advanced commands not shown by `-h`.

## 1. CLI Usage

### 1.1 Basic format

```bash
surge-cli [--remote password@host:port] [--raw] <command> [args...]
```

Common executable location on macOS:

```bash
/Applications/Surge.app/Contents/Applications/surge-cli
```

- `--raw`: output raw JSON (recommended for agents).
- `--remote` / `-r`: connect to a remote instance.
- `--check <path>` / `-c <path>`: validate a profile file only.
- `--help` / `-h`: print help.
- If no command is provided, it enters interactive mode.
- Command keywords are handled case-insensitively by the controller.

### 1.2 Response envelope

Responses are JSON and usually include:

- `result`: success text
- `error`: error text
- payload fields (for example `requests`, `environment`)
- `hasMore` for streaming commands (`true` means more chunks follow)

## 2. Full Command Catalog

The table below is the full top-level command set handled by the controller (not just the subset shown in `-h`).

| Command | Args | Description | Notes |
|---|---|---|---|
| `watch` | `[event ...]` | subscribe to events; without args unsubscribes | `watch request` is common |
| `dump` | `<type> [extra]` | dump runtime state data | see 3.1 |
| `test` | `<type>` | environment diagnostics | see 3.2 |
| `environment` | none | return current environment dictionary | |
| `set` | `<key>=<value> ...` | update environment | see 4 |
| `set-log-level` | `<level>` | change runtime log level | does not write profile |
| `stop` | none | stop Surge | |
| `kill` | `<connection-id>` | terminate a connection | |
| `test-group` | `<group-name>` | retest a policy group immediately | |
| `test-all-policies` | none | retest all policies | |
| `test-policy` | `<policy...>` | test one or more policies | |
| `test-policy-udp` | `<policy...>` | UDP policy test | |
| `test-policy-external-ip` | `<policy>` | probe external IP via a policy | STUN-based |
| `test-policy-nat-type` | `<policy>` | probe NAT type via a policy | STUN-based |
| `test-policy-bandwidth` | `<download\|upload> <policy>` | run bandwidth diagnostics via a policy | streaming output |
| `flush` | `<type>` | flush data | currently only `dns` |
| `reload` | none | reload main profile | |
| `show-policy` | `<policy-name>` | show policy details | |
| `retrieve-data` | `<record-id> <request\|response> [replica-dir]` | fetch captured request/response body | data-channel command |
| `test-network` | none | network delay test | returns `time` |
| `script` | `evaluate <base64-js> [mockType] [timeout] [engine] [argument]` | evaluate script | CLI has a convenience wrapper, see 3.3 |
| `diagnostics` | none | start diagnostics event stream | pair with `stop-diagnostics` |
| `stop-diagnostics` | none | stop diagnostics event stream | |
| `get-resource` | `device-icon <id...>` | fetch device icons (Base64) | |
| `set-dhcp-device` | `<mac> <type> [value]` | set DHCP device parameters | macOS only, see 3.4 |
| `remove-device-record` | `<identifier...>` | remove device records | macOS only |
| `switch-profile` | `<profile-name>` | switch to another profile | |
| `update-profile` | `<base64-rule-section>` | update Rule section | macOS only |
| `proxy-runtime-status` | `<line-hash>` | show proxy runtime status | |
| `add-temp-rule` | `<rule>` | add temporary rule | |
| `del-temp-rule` | `<rule>` | delete temporary rule | |
| `update-temp-rule` | `<rule> <new-policy>` | change policy of temporary rule | |
| `flush-temp-rule` | none | clear all temporary rules | |
| `unattended-upgrade` | none | unattended upgrade | macOS only |
| `provider-message` | `<base64-data>` | send message to Packet Tunnel Provider | unsupported on macOS |
| `external-resource` | `list \| update <key\|all>` | external resource listing and update | |
| `test-ponte` | `<device-ponte-name>` | Ponte diagnostics | streaming output |

## 3. Subcommand Details

### 3.1 `dump <type>`

Supported `type` values:

- `active`
- `recent`
- `request`
- `dns`
- `traffic`
- `auto-test-group-result`
- `policy`
- `rule`
- `map-remote`
- `map-local`
- `profile`
- `event`
- `policy-group-sub-policies`
- `traffic-stat` (optional second arg: `prefix`)
- `traffic-stat-host`
- `temp-rule`
- `summary`
- `virtual-ip-db`
- `smart-group-info`

`surge-cli -h` shows only a subset.

For profile display mode in CLI:

```bash
surge-cli dump profile original
surge-cli dump profile effective
```

### 3.2 `test <type>`

Supported `type` values:

- `v4-router`
- `dns`
- `encrypted-dns`
- `external-ip`
- `nat-type`

Note: `test-policy*` commands are separate top-level commands, not part of `test <type>`.

### 3.3 `script evaluate` (CLI convenience form)

Common CLI form:

```bash
surge-cli script evaluate <script-js-path> [mock-script-type] [timeout] [engine] [argument]
```

CLI reads `<script-js-path>`, converts it to Base64, and sends it to controller `script evaluate`.

Supported `mock-script-type` strings:

- `http-request`
- `http-response`
- `cron`
- `event`
- `rule`
- `dns`
- `generic`

Supported `engine` strings:

- `auto`
- `jsc`
- `webview`

### 3.4 `set-dhcp-device` subtypes (macOS only)

```text
set-dhcp-device <mac> takeover [0|1]
set-dhcp-device <mac> disable-udp-fast-path [0|1]
set-dhcp-device <mac> address [ipv4-or-empty]
set-dhcp-device <mac> name [display-name-or-empty]
set-dhcp-device <mac> icon [icon-name-or-empty]
```

### 3.5 `external-resource`

- `external-resource list`
- `external-resource update <hash-key>`
- `external-resource update all`

`list` includes `ready`, and remote resources may include `updatedAt`.

### 3.6 `watch` event types

Supported event names:

- `real-time-speed`
- `auto-test-group`
- `traffic`
- `request`
- `request-update`
- `summary`
- `environment`
- `dns`
- `diagnostics`
- `reload`
- `shutdown`
- `device-name-map`
- `policy-benchmark`
- `device-info`
- `dns-flush`

Examples:

```bash
surge-cli watch request
surge-cli watch summary environment traffic
surge-cli watch              # unsubscribe
```

## 4. `set` Command and Environment Dictionary (Key Section)

### 4.1 Syntax

```bash
surge-cli set <key-path>=<value> [<key-path>=<value> ...]
```

- Multiple `key=value` pairs are allowed in one command.
- Any argument without `=` fails with `Illegal parameter`.
- `<nil>` and `(null)` are treated as `nil`.

### 4.2 Key-path behavior

- Normal key-paths are applied via key-path assignment.
- Prefix `ProxyGroupSelection.` is handled as map merge for select-group decisions.
- Prefix `AutoPolicyGroupOverride.` is handled as map merge for auto-group overrides.

Examples:

```bash
surge-cli set ProxyMode=2
surge-cli set ProxyGroupSelection.Proxy=HK
surge-cli set AutoPolicyGroupOverride.Streaming=<nil>
surge-cli set RewriteEnabled=0 ScriptingEnabled=1
```

### 4.3 Top-level environment keys

| Key | Type | Meaning | Example |
|---|---|---|---|
| `ProxyGroupSelection` | `dict<string,string>` | current selection for select groups | `ProxyGroupSelection.<group>=<policy>` |
| `AutoPolicyGroupOverride` | `dict<string,string\|nil>` | override selection for auto groups | `AutoPolicyGroupOverride.<group>=<policy-or-<nil>>` |
| `ProxyMode` | `int` | outbound mode: `0=Direct` `1=Global Proxy` `2=Rule` | `ProxyMode=2` |
| `AllProxyModePolicyNameKey` | `string` | policy name used in global proxy mode | `AllProxyModePolicyNameKey=ProxyA` |
| `MitMEnabled` | `bool` | MITM switch | `MitMEnabled=1` |
| `RewriteEnabled` | `bool` | Rewrite switch | `RewriteEnabled=1` |
| `ScriptingEnabled` | `bool` | Scripting switch | `ScriptingEnabled=1` |
| `Replica` | `bool` | HTTP capture switch | `Replica=1` |
| `ReplicaSessionParameters` | `dict` | HTTP capture session parameters | see 4.4 |
| `InMemoryCaptureFilter` | `dict` | in-memory capture filter params | see 4.5 |
| `OnDiskCaptureFilter` | `dict` | on-disk capture filter params | see 4.5 |
| `PacketCaptureEnabled` | `bool` | packet capture switch | effective on iOS/tvOS |
| `PacketCaptureParameters` | `dict` | packet capture parameters | see 4.6 |
| `SGEnvironmentCellularModeEnabledKey` | `bool` | cellular mode switch | `SGEnvironmentCellularModeEnabledKey=1` |
| `SGEnvironmentCellularModeProcessPathsKey` | `array<string>` | allowed process paths in cellular mode | complex type, see 4.7 |

### 4.4 `ReplicaSessionParameters` fields

| Field | Type | Default |
|---|---|---|
| `sizeLimit` | `int` | `52428800` (50MB) |
| `requestCountLimit` | `int` | `100` |
| `timeLimit` | `int` (seconds) | `180` |
| `mitmOverride` | `bool` | `1` |
| `mitmOverrideHostnames` | `array<string>` | built-in default list |
| `mitmOverrideHostnamesDisabled` | `array<string>` | empty |

Example (scalar updates are straightforward):

```bash
surge-cli set Replica=1 ReplicaSessionParameters.requestCountLimit=200
```

### 4.5 `InMemoryCaptureFilter` / `OnDiskCaptureFilter` fields

| Field | Type | Meaning |
|---|---|---|
| `httpOnly` | `bool` | HTTP-only capture |
| `hideCrashReporterRequest` | `bool` | hide crash reporter traffic (default `1`) |
| `hideAppleRequest` | `bool` | hide Apple traffic |
| `hideUDP` | `bool` | hide UDP traffic |
| `filterType` | `int` | `0=None` `1=Whitelist` `2=Blacklist` `3=Pattern` |
| `keywordFilter` | `array<string>` | keyword list |
| `disabledKeywordFilter` | `array<string>` | disabled keywords |

### 4.6 `PacketCaptureParameters` fields

| Field | Type | Default |
|---|---|---|
| `sizeLimit` | `int` | `1048576` (1MB) |
| `packetCountLimit` | `int` | `100` |
| `timeLimit` | `int` (seconds) | `180` |
| `packetType` | `int` | `0=Unknown` `1=ICMP` `6=TCP` `17=UDP` |

### 4.7 Type handling notes (important for agents)

- CLI sends values as strings; booleans/integers rely on runtime conversion (`boolValue` / `integerValue`).
- Complex arrays/dictionaries are not ideal to set as raw string literals from shell commands.
- Recommended approach:
  - prefer scalar key-path updates;
  - use JSON/SDK path for complex structures when possible;
  - fetch `environment` first, then apply minimal deltas.

### 4.8 Runtime behavior notes

- Successful `set` triggers environment-change notifications.
- If `MitMEnabled=1` is invalid under current runtime conditions, it is auto-corrected to `0`.
- In global proxy mode (`ProxyMode=1`), an invalid `AllProxyModePolicyNameKey` is auto-fallbacked to a valid policy (or `DIRECT`).

## 5. Practical Recommendations for AI Agents

1. Prefer `--raw` and parse JSON directly.
2. Before mutating settings, collect context with `environment`, `dump policy`, and `dump profile`.
3. For streaming commands (`diagnostics`, `test-policy-bandwidth`, `test-ponte`), handle incremental chunks and end conditions.
4. Check platform capability before using platform-limited commands (`update-profile`, `set-dhcp-device`, `provider-message`).
