# Publishing

This package can be listed without npm: it lives at the repository root, has no
build step, and declares `dsh.bundle.patch`, so a pinned Git commit is an
installable source. Both community indexes accept that form.

## Git-only listing (no npm account)

- Repository: `https://github.com/little-bird-vodka/dsh-session-done-notifier`
- Version: `0.2.0`
- Commit: `76852daa700cee547e0b4e6e34b9d3747751e107`
- Package root: repository root (no `path:`)
- Install: `dsh plugin --profile desktop add github:little-bird-vodka/dsh-session-done-notifier`

**dshopen**: use the [plugin request](https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml)
with the repo URL, version, full 40-character SHA, MIT license, tested DSH
version, and a Windows-only note. A pinned Git listing is upgraded only after a
maintainer checks the new commit, so reply in the issue for later releases.

**dsh.works**: add one entry to `data/plugins.json` in
[dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)
with `repo`, no `npm`, `verifiedAgainst: "0.2.2-rc.1"`, `lastVerified:
"2026-11-06"`, and an honest `status`. The site generates
`dsh plugin --profile web add github:<repo>` for a Git-only entry.

## Prerequisites for npm

- A public GitHub repository for this package (suggested: `little-bird-vodka/dsh-session-done-notifier`).
- An npm account with 2FA; `npm login` on the machine that publishes.
- The package name `dsh-session-done-notifier` (checked available on 2026-11-06). If it is taken by publish time, choose another unscoped name or an owned scope and update `package.json`, `cordis.patch.yml`, and the `window.__ModuleLoader__` id in `client.js`.
- `engines.dsh` already declares the tested range (`>=0.2.2-rc.1 <0.3.0`). Bump it when a newer DSH is verified.

## 1. Publish to npm

```sh
npm pack --dry-run   # inspect files
npm publish          # unscoped public package
npm view dsh-session-done-notifier version
```

The published tarball must include `index.js`, `client.js`, `lib/popup.ps1`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md`, and `LICENSE`. `files` in `package.json` lists them.

## 2. Verify a clean install

Use a **separate profile**, not the profile you develop in:

```sh
dsh plugin --profile sdn-test add dsh-session-done-notifier@0.2.0
dsh --profile sdn-test --dump-config
```

Then launch that profile's Web GUI and confirm:

- the bundle and its rows load, and the Plugins page shows the title, description, and icon in en/zh;
- both composer toggles persist a change to `$DSH_HOME/session-done-notifier.json`;
- a turn-end popup appears, and clicking it from another session returns to the source session;
- a pending question and a pending approval each produce their own popup;
- `engines.dsh` accepts the running DSH (a refused install means the range is wrong).

## 3. List on Open Plugin Market (dshopen)

Open the [plugin request](https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml) with:

- npm package name: `dsh-session-done-notifier`
- public repository URL and license: MIT
- one sentence of purpose, plus the tested DSH version and Windows-only note
- optional: logo and 1–6 screenshots (hide keys and personal data)

The index follows the npm `latest` tag. Its security review expects local `webServer` routes to use `ctx.connection.requestRejection`; this package does. Explain the local PowerShell helper and the `%TEMP%` activation file in the request, since a reviewer will notice them.

## 4. List on dsh.works/awesome-dsh-plugins

1. Add an entry to `data/plugins.json` in [dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins), following `data/schema.json`.
2. Set `verifiedAgainst` to the exact DSH version tested, `lastVerified` to today, and `status` honestly (`verified` needs evidence).
3. Run:

   ```sh
   node scripts/validate.mjs
   node scripts/render.mjs
   ```

4. Commit both generated files and open the PR. CI runs the same checks.

The npm name must resolve; the registry checks it against npm. The peer/engine gate must admit the tested DSH version.

## 5. Optional: your own index

If you prefer not to wait for a community review, publish a format-1 index on any HTTPS static host and share its URL. Users add it under **Plugins → Experimental plugins → Custom plugin indexes → Discover → Add index source**.

Minimal entry:

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins", "zh": "我的 DSH 插件" },
  "plugins": [{
    "name": "dsh-session-done-notifier",
    "title": { "en": "Session Done Notifier", "zh": "会话完成提醒" },
    "description": "Bottom-right popups for turn completion, questions and approvals.",
    "icon": "icons/session-done-notifier.svg",
    "repository": { "url": "https://github.com/little-bird-vodka/dsh-session-done-notifier" },
    "versions": [{
      "version": "0.2.0",
      "publishTimestamp": 1793980800,
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
    }]
  }]
}
```

`publishTimestamp` must be the npm publish time in Unix seconds; regenerate it after every release.

## Release checklist

- [ ] `npm pack --dry-run` contains every runtime file and no local artifacts.
- [ ] `engines.dsh` matches the version tested.
- [ ] Public repo has `LICENSE`, `README.md`, and the `repository` field.
- [ ] Clean-profile install and the four path checks above pass.
- [ ] `git tag <name>@<version>` and push the tag with `main`.
- [ ] npm `latest` updated; market index picks it up (dshopen follows `latest`; dsh.works rechecks).
