# dsh-session-done-notifier

A DSH desktop plugin that shows a bottom-right popup when a session needs you:

- a turn finishes and the session waits for your next prompt;
- the session calls `ask_user_question` (including plan review);
- a tool approval is waiting for your confirmation.

It works while the DSH window is minimized, covered, or hidden in the tray. A click restores the window, brings it to the front, and reopens the session that sent the reminder.

Windows-only. DSH Desktop `0.2.3-alpha.2` is the tested version (`engines.dsh` allows `>=0.2.3-alpha.2 <0.3.0`).

## Features

- **Turn outcomes**: `completed`, `error` (with the `LlmFailure` message or code), `aborted`/`interrupted`, `max-tokens`, and `blocked` get different titles and bodies. Errors do not reuse the previous reply preview.
- **Distinct icons**: every popup kind has its own shape and color, so the type is readable without relying on color alone.
- **Optional Windows chime**: one normalized copy of the system notification sound, cached under `%TEMP%`; it respects the system volume and can be turned off. With popups off and sound on it plays the chime alone, without a card.
- **Click to return**: restores a minimized window, raises a covered one, reopens a tray-hidden window through the app's own `show()` path, and switches back to the source session.
- **Two composer toggles**: popup on/off and sound on/off, independent and persisted per profile.
- **No runtime dependencies**: plain ESM on the Host and a small PowerShell/WPF helper on the desktop.

## Install

From GitHub (works without npm):

```sh
dsh plugin --profile desktop add github:little-bird-vodka/dsh-session-done-notifier
```

Pin a release commit when you want a reproducible install:

```sh
dsh plugin --profile desktop add git+https://github.com/little-bird-vodka/dsh-session-done-notifier.git#4bb44bb7fbbe6abf20265aa88989300aac70dcc8
```

From npm, when published:

```sh
dsh plugin --profile desktop add dsh-session-done-notifier
```

From source, with the package directory available locally:

```text
plugin_manager(action="install_bundle",
               target="<absolute path to this package>")
```

After installation, open the **Plugins** page and confirm the bundle is enabled and shows its own icon. On a running profile the Host half may need a DSH restart before its timers/listeners are live; a new install can apply through HMR.

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

The toggles are independent:

| bell | speaker | result |
| --- | --- | --- |
| on | on | popup with chime |
| on | off | popup, silent |
| off | on | chime only, no card |
| off | off | nothing |

The sound-only path starts the same helper with `-SoundOnly`, which plays the normalized chime and exits before any WPF window is created.

State is stored in `$DSH_HOME/session-done-notifier.json`:

```json
{ "enabled": true, "sound": true }
```

The Client reads and writes it through the same-origin routes `/session-done-notifier/settings`, `/session-done-notifier/activate`, and `/session-done-notifier/pending`. Every route keeps the WebServer's default `auth: 'required'` admission and refuses a handler call without an admitted Peer, so a composition that admits anonymous requests cannot reach it. The custom `x-session-done-notifier: 1` header is kept as a second barrier against cross-site form posts.

## Click behavior

The helper first records the source session, then restores the window:

- minimized: `SW_RESTORE` + `SetForegroundWindow`;
- visible but covered: `BringWindowToTop` + `SetForegroundWindow` only (no `ShowWindow` on a visible window);
- hidden to tray: the Electron renderer stays throttled if a native `ShowWindow` is used, so the helper starts `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE` removed. The second instance forwards through single-instance and the app's own `window.show()` / `window.focus()` runs;
- not running: `shell:AppsFolder\com.deepseek.dsh`.

The click is absorbed for 250 ms before the popup closes, so a double-click cannot fall through to the window or taskbar underneath.

The source session is written to `%TEMP%\dsh-session-done-notifier-activate-<pid>.json` (one file per Host process); the focused Client reads it once through the authenticated `/activate` route and calls `uiWorkspace.openSession(sessionId)`. No unauthenticated route accepts the click.

## Security and privacy

- The plugin sends **no network requests**. The popup is a local WPF window; the sound is played from `%SystemRoot%\Media` with `winmm!PlaySound`.
- The helper runs `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/popup.ps1` with `windowsHide`, and is stopped when the plugin unloads.
- Routes require the Host's browser authentication and the plugin's static header. The activation file is a local `%TEMP%` file read only by the Host, containing a session id and timestamp.
- Popups show session titles and the last assistant text on screen; be aware when sharing or recording the screen.
- Settings and the activation file live outside the plugin package: `$DSH_HOME/session-done-notifier.json`, `%TEMP%\dsh-session-done-notifier-activate-<pid>.json`, plus a bounded diagnostic log at `%TEMP%\dsh-session-done-notifier.log` (64 KiB cap).

## Compatibility and known limits

- **Windows only.** The helper uses WPF, PowerShell, `winmm`, `user32`, and the Electron window class `Chrome_WidgetWin_1`. On other platforms the Host half stays idle.
- **Desktop shell facts.** Tray restore depends on the shell's single-instance behavior, `ELECTRON_RUN_AS_NODE` in the Host environment, and the window's `rcNormalPosition`. A future desktop shell may change these; `engines.dsh` is a tested range, not a guarantee.
- **Internal DSH events.** `api-session/status`, `session/event`, `turn/end`, `uiSession.sessionStatus`, and `webServer` routes are used by this plugin; DSH upgrades can change them.
- **Client service injection.** The approval observer reads `ctx.uiSession.sessionStatus`, a separate Cordis service since DSH `0.2.2-rc.2`. Versions 0.2.1 and later inject `uiSession.sessionStatus`; without that inject the read throws during `apply`, the Client half unloads, and the composer toggles, click-to-return, and approval popups disappear while Host-side notifications keep working. 0.2.0 had this bug on DSH `0.2.3-alpha.2`.
- **Route admission.** DSH `0.2.2-rc.2` removed `ctx.connection.requestRejection` and made every WebServer route `auth: 'required'` by default. 0.2.2 relies on the admitted Peer passed to the handler; 0.2.1 still called the removed method, so its routes answered 400 and the composer toggles reverted, click-to-return never consumed the activation file, and approval reports were dropped.
- **Host process crash.** If the DSH Host process itself crashes or is killed, no popup is possible: the plugin and the popup helper live in that process. A failed turn that ends with `turn/end: error` is covered.
- **Approvals need a connected Client.** They are reported from the Client's pending-interaction state; if no Client is connected, the approval UI is unavailable too.
- **Cold start.** Each popup starts a PowerShell/WPF process (roughly 0.6–1.2 s). Simultaneous reminders start separate helpers and stack upward. A sound-only reminder also starts a helper (about 0.5 s before the chime); there is no resident process.
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

## Listings

- **Open Plugin Market (dshopen)**: listed from commit `76852da` with 0.2.0; the 0.2.3 update is requested in [issue #290](https://github.com/polang233/dsh-plugin-index/issues/290#issuecomment-7154729400).
- **dsh.works**: listed with 0.2.0 ([PR #223](https://github.com/dshworks/awesome-dsh-plugins/pull/223), following the closed #222); the 0.2.3 re-verification is [PR #258](https://github.com/dshworks/awesome-dsh-plugins/pull/258).

Both entries install from the pinned Git commit while no npm release exists. The 0.2.0 listing is affected by the Client-half and route bugs fixed in 0.2.2, and lacks the 0.2.3 independent sound toggle.

## Verification
- Turn completion, question, approval, session-targeted click, tray/minimized/covered/visible click restore, and both toggles were verified on DSH `0.2.1-rc.2`.
- On `0.2.2-rc.1`: install applied with no warnings, the Client slot stayed active, an unauthenticated `GET /settings` returned 401, authenticated Client `GET`/`POST` requests succeeded (`cookie=yes`), a question popup appeared, and a completion popup clicked from another session returned to the source session through the `%TEMP%` activation file and the authenticated `/activate` route.
- Both composer toggles were flipped on `0.2.2-rc.1` and the settings file reflected each change (bell/speaker).
- On `0.2.3-alpha.2` (2026-11-25): 0.2.0's Client half failed to apply with `cannot get property "uiSession.sessionStatus" without inject`, so `conversation.input.right` had no occupant and the activation file written by a popup click was never consumed. 0.2.1 restored the Client half (active slot occupant, both toggles rendered), but its routes still called the removed `connection.requestRejection`, so a toggle click reverted and the activation file stayed unread.
- On `0.2.3-alpha.2` with 0.2.2: both composer toggles persist their state to `$DSH_HOME/session-done-notifier.json` (clicked, and the file changed), and the Client consumed a pending activation file through the authenticated `/activate` route.
- On `0.2.3-alpha.2` with 0.2.3: with the bell off and the speaker on, a session completion and an `ask_user_question` call each played the full chime with no popup; sound-only playback is synchronous, so the helper cannot exit before the 1.29 s chime ends. An async first attempt logged `played` but was cut off by the immediate exit, which is why 0.2.3 waits for playback.
- Pending checks on 0.2.3: a popup click switching back to another session (the navigation itself), a real approval popup, and a live failed-turn popup.
- The `error`/`aborted` copy and icons were exercised against real `turn/end` reasons from local session logs, but a live failed-turn popup is still an occasional check rather than a scripted test.

## License

MIT. See [LICENSE](LICENSE).
