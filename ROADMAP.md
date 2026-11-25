# Roadmap

## Current

- 0.2.2 replaces the route admission that DSH `0.2.3-alpha.2` removed (`connection.requestRejection`) with the admitted Peer, so the composer toggles, click-to-return and approval reports work again.
- 0.2.1 fixed the Client-half inject but still used the removed route check; treat it as superseded.
- Public at `https://github.com/little-bird-vodka/dsh-session-done-notifier`, tag `session-done-notifier@0.2.2` (commit `962bb37`).
- Install is Git-only for now: `dsh plugin --profile desktop add github:little-bird-vodka/dsh-session-done-notifier`.
- Both community indexes still hold 0.2.0 at commit `76852da`, verified against `0.2.2-rc.1`; both need an update request for 0.2.2:
  - Open Plugin Market: https://github.com/polang233/dsh-plugin-index/issues/290 (closed as completed on 2026-11-07)
  - dsh.works: admitted through PR #223, not #222; update `data/plugins.json` (version, `verifiedAgainst`, `lastVerified`)

## Done

- 2026-11-25: 0.2.2 — use the route's admitted Peer instead of the removed `connection.requestRejection`; verified both composer toggles persist and a pending activation file is consumed on DSH `0.2.3-alpha.2`; `main` and the tag pushed.
- 2026-11-25: 0.2.1 — inject `uiSession.sessionStatus`; narrow `engines.dsh` to `>=0.2.3-alpha.2 <0.3.0`; declare `dsh.bundle.platforms: ["win32"]`; `main` and the tag pushed (superseded by 0.2.2 because the routes still failed).
- 2026-11-07: admitted to dshopen (issue #290) and dsh.works (PR #223) from commit `76852da`, `verifiedAgainst: 0.2.2-rc.1`.
- 2026-11-06: split from the `dsh-plugins` monorepo; package metadata, MIT license, publishing notes.
- 2026-11-06: authenticated `webServer` routes (`connection.requestRejection`); popup activation moved from an unauthenticated POST to a per-process `%TEMP%` file plus an authenticated GET.
- 2026-11-06: verified on DSH `0.2.2-rc.1` — install/load, unauthenticated 401, authenticated Client GET/POST, question popup, both toggles, cross-session click navigation.

## Next

- Update both listings to `0.2.2` / `0.2.3-alpha.2` once the tag is public.
- Verify a popup click switching back to another source session (the navigation itself), a live approval popup, and a failed-turn (`turn/end: error`) popup on 0.2.2.
- Optional: publish to npm as `dsh-session-done-notifier`, then switch the markets from the pinned Git commit to the npm release (dshopen follows npm `latest`).
