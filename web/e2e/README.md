`smoke.mjs` drives the built prototype (`npm run build:proto`) in Chrome with Playwright:
basic and advanced chat, approval card, tool steps, every 全部功能 page used in v1,
plugin install + sandboxed panels, a dsh-Go plugin panel, the hard-rule guard (a hostile
CSS rule hiding the approval card must switch plugin CSS off), artifacts, the question
card, and mobile layout. Screenshots land in `e2e/shots/`.

It loads Playwright from `/opt/npm-tools/node_modules` and Chrome from
`/usr/bin/google-chrome`; adjust the two paths at the top for your machine.

`companion.mjs` (陪伴) runs the real MaiDSH plugins: `maidsh-host.mjs` loads `maidsh/*/lib` under
cordis with a scripted model and serves `dist-proto` from the same origin. Run `npm install` in
`maidsh/` once first (for cordis).

`lore.mjs` (设定集) uses the same host with `modules: ['lore']` (maidsh/lore). The prototype's
workspaces are mirrored into the host's `workspaceRegistry` (`host.setWorkspaces`), read from
`window.__mockEngine`. Files to import use ASCII names: the test browser's file chooser drops
non-ASCII paths.
