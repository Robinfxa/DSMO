`smoke.mjs` drives the built prototype (`npm run build:proto`) in Chrome with Playwright:
basic and advanced chat, approval card, tool steps, every 全部功能 page used in v1,
plugin install + sandboxed panels, a dsh-Go plugin panel, the hard-rule guard (a hostile
CSS rule hiding the approval card must switch plugin CSS off), artifacts, the question
card, and mobile layout. Screenshots land in `e2e/shots/`.

It loads Playwright from `/opt/npm-tools/node_modules` and Chrome from
`/usr/bin/google-chrome`; adjust the two paths at the top for your machine.
