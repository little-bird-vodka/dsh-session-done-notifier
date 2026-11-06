# Roadmap

## Current

- 0.2.0 is public at `https://github.com/little-bird-vodka/dsh-session-done-notifier` with tag `session-done-notifier@0.2.0`.
- Install is Git-only for now: `dsh plugin --profile desktop add github:little-bird-vodka/dsh-session-done-notifier`.
- Listed for review:
  - Open Plugin Market: https://github.com/polang233/dsh-plugin-index/issues/290
  - dsh.works registry: https://github.com/dshworks/awesome-dsh-plugins/pull/222

## Done

- 2026-11-06: split from the `dsh-plugins` monorepo; package metadata, MIT license, publishing notes.
- 2026-11-06: authenticated `webServer` routes (`connection.requestRejection`); popup activation moved from an unauthenticated POST to a per-process `%TEMP%` file plus an authenticated GET.
- 2026-11-06: verified on DSH `0.2.2-rc.1` — install/load, unauthenticated 401, authenticated Client GET/POST, question popup, both toggles, cross-session click navigation.
- 2026-11-06: public repository and release tag pushed; dshopen issue and dsh.works PR opened.

## Next

- Address review feedback in issue #290 / PR #222; update the listing to the reviewed commit if the default branch moves.
- Verify a live approval popup and a failed-turn (`turn/end: error`) popup on 0.2.2.
- Optional: publish to npm as `dsh-session-done-notifier`, then switch the markets from the pinned Git commit to the npm release (dshopen follows npm `latest`).
