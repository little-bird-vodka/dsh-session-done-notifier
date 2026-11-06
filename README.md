# dsh-session-done-notifier

A DSH desktop plugin that shows a bottom-right popup when a session needs you:

- a turn finishes and the session waits for your next prompt;
- the session calls `ask_user_question` (including plan review);
- a tool approval is waiting for your confirmation.

It works while the DSH window is minimized, covered, or hidden in the tray. A click restores the window, brings it to the front, and reopens the session that sent the reminder.

Windows-only. DSH Desktop `0.2.2-rc.1` is the tested version (`engines.dsh` allows `>=0.2.2-rc.1 <0.3.0`).

## Features

- **Turn outcomes**: `completed`, `error` (with the `LlmFailure` message or code), `aborted`/`interrupted`, `max-tokens`, and `blocked` get different titles and bodies. Errors do not reuse the previous reply preview.
- **Distinct icons**: every popup kind has its own shape and color, so the type is readable without relying on color alone.
- **Optional Windows chime**: one normalized copy of the system notification sound, cached under `%TEMP%`; it respects the system volume and can be turned off.
- **Click to return**: restores a minimized window, raises a covered one, reopens a tray-hidden window through the app's own `show()` path, and switches back to the source session.
- **Two composer toggles**: popup on/off and sound on/off, persisted per profile.
- **No runtime dependencies**: plain ESM on the Host and a small PowerShell/WPF helper on the desktop.

## Install

From npm (normal channel):

```sh
dsh plugin --profile desktop add dsh-session-done-notifier
```

From source, with the package directory available locally:

```text
plugin_manager(action="install_bundle",
               target="<absolute path to this package>")
```

After installation, open **Settings → Plugins** and confirm the bundle is enabled and shows its own icon. On a running profile the Host half may need a DSH restart before its timers/listeners are live; a new install can apply through HMR.

## What triggers a popup

| Trigger | Title (zh / en) | Body |
| --- | --- | --- |
| Turn ends `completed` | 回复完成 / Reply ready | last assistant text |
| Turn ends `error` | 会话出错 / Session error | `LlmFailure.message` or code |
| Turn ends `aborted` / `interrupted` | 已中止 / Stopped | stop reason |
| Turn ends `max-tokens` | 输出达到上限 / Output limit | fixed copy |
| Turn ends `blocked` | 本轮被阻止 / Turn blocked | fixed copy |
| `ask_user_question` tool call | 需要你的回答 / Answer needed | first question |
| Plan review question | 计划待确认 / Plan review | fixed copy |
| Pending approval | 需要你的确认 / Approval needed | approval reason or tool name |

The completion popup is driven by `api-session/status` plus the durable `turn/end` reason. Questions are detected from the committed `tool/call` event, before the tool starts waiting. Approvals are reported by the Client from `uiSession.sessionStatus.pendingInteraction`, because the approval waterfall is claimed by the Client answerer before a Host listener can see it.

Subagent sessions do not pop up. The dispatcher dedupes by session/tool call and folds same-session repeats within 1.5 s.

## Icons

| Kind | Shape | Color |
| --- | --- | --- |
| `completed` | check | green `#4ADE80` |
| `question` | question mark | blue `#60A5FA` |
| `plan` | document | purple `#A78BFA` |
| `approval` | shield + check | amber `#FBBF24` |
| `error` | circle + exclamation | red `#F87171` |
| `aborted` | stop square | slate `#94A3B8` |
| `limit` | warning triangle | orange `#FB923C` |
| `blocked` | ban circle | rose `#FB7185` |

Icons are 24×24 stroke paths on a 32×32 tinted badge; the helper receives the kind with `-Kind` and falls back to `completed` for unknown values.

## Composer toggles

Two 24 px buttons appear in the composer tool row (`conversation.input.right`):

- bell: popup on/off;
- speaker: sound on/off.

State is stored in `$DSH_HOME/session-done-notifier.json`:

```json
{ "enabled": true, "sound": true }
```

The Client reads and writes it through the same-origin routes `/session-done-notifier/settings`, `/session-done-notifier/activate`, and `/session-done-notifier/pending`. Every route is admitted through `ctx.connection.requestRejection(request)`; a deployment without the Connection service refuses the routes rather than falling back to a header or loopback check. The custom `x-session-done-notifier: 1` header is kept as a second barrier against cross-site form posts.

## Click behavior

The helper first records the source session, then restores the window:

- minimized: `SW_RESTORE` + `SetForegroundWindow`;
- visible but covered: `BringWindowToTop` + `SetForegroundWindow` only (no `ShowWindow` on a visible window);
- hidden to tray: the Electron renderer stays throttled if a native `ShowWindow` is used, so the helper starts `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE` removed. The second instance forwards through single-instance and the app's own `window.show()` / `window.focus()` runs;
- not running: `shell:AppsFolder\com.deepseek.dsh`.

The click is absorbed for 250 ms before the popup closes, so a double-click cannot fall through to the window or taskbar underneath.

The source session is written to `%TEMP%\dsh-session-done-notifier-activate.json`; the focused Client reads it once through the authenticated `/activate` route and calls `uiWorkspace.openSession(sessionId)`. No unauthenticated route accepts the click.

## Security and privacy

- The plugin sends **no network requests**. The popup is a local WPF window; the sound is played from `%SystemRoot%\Media` with `winmm!PlaySound`.
- The helper runs `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/popup.ps1` with `windowsHide`, and is stopped when the plugin unloads.
- Routes require the Host's browser authentication and the plugin's static header. The activation file is a local `%TEMP%` file read only by the Host, containing a session id and timestamp.
- Popups show session titles and the last assistant text on screen; be aware when sharing or recording the screen.
- Settings and the activation file live outside the plugin package: `$DSH_HOME/session-done-notifier.json`, `%TEMP%\dsh-session-done-notifier-activate.json`, plus a bounded diagnostic log at `%TEMP%\dsh-session-done-notifier.log` (64 KiB cap).

## Compatibility and known limits

- **Windows only.** The helper uses WPF, PowerShell, `winmm`, `user32`, and the Electron window class `Chrome_WidgetWin_1`. On other platforms the Host half stays idle.
- **Desktop shell facts.** Tray restore depends on the shell's single-instance behavior, `ELECTRON_RUN_AS_NODE` in the Host environment, and the window's `rcNormalPosition`. A future desktop shell may change these; `engines.dsh` is a tested range, not a guarantee.
- **Internal DSH events.** `api-session/status`, `session/event`, `turn/end`, `uiSession.sessionStatus`, and `webServer` routes are used by this plugin; DSH upgrades can change them.
- **Host process crash.** If the DSH Host process itself crashes or is killed, no popup is possible: the plugin and the popup helper live in that process. A failed turn that ends with `turn/end: error` is covered.
- **Approvals need a connected Client.** They are reported from the Client's pending-interaction state; if no Client is connected, the approval UI is unavailable too.
- **Cold start.** Each popup starts a PowerShell/WPF process (roughly 0.6–1.2 s). Simultaneous reminders start separate helpers and stack upward.
- **Primary monitor.** The card is fixed at the primary work area's bottom-right; it does not follow the monitor under the cursor.
- **Sound at low volume.** The chime is normalized to about 92% peak, but a low system volume or a muted output device still silences it.
- Questions are recognized by the tool name `ask_user_question`; a rename in DSH needs `QUESTION_TOOL_NAME` updated.

## Development

The package is plain ESM with no build step:

```text
index.js          Host half: events, routes, settings, spawn helper
client.js         Client half: two toggles, focus navigation, approval observer
lib/popup.ps1     WPF card, sound, window activation
cordis.patch.yml  bundle patch (entry id: session-done-notifier)
locale/           en/zh display metadata
icon.svg          bundle icon
```

Useful checks:

```powershell
# syntax
node --check index.js
node --check client.js
$errors = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  "$PWD\lib\popup.ps1", [ref]$tokens, [ref]$errors)

# package contents before publishing
npm pack --dry-run
```

Install a local checkout with `plugin_manager install_bundle` and restart DSH after Host changes. Settings survive a reinstall; removing the bundle leaves the settings file in place.

## Verification

- Turn completion, question, approval, session-targeted click, tray/minimized/covered/visible click restore, and both toggles were verified on DSH `0.2.1-rc.2`.
- The 0.2.2-rc.1 update is verified for install/load and the core paths during the standalone migration; see the release notes for the exact checks.
- The `error`/`aborted` copy and icons were exercised against real `turn/end` reasons from local session logs, but a live failed-turn popup is still an occasional check rather than a scripted test.

## License

MIT. See [LICENSE](LICENSE).
