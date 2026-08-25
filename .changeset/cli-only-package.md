---
"cmux-captain": major
---

Drop the unused library entry point: `cmux-captain` is a CLI.

`package.json` declared `main`, `types` and `exports` pointing at a 31-name
`src/index.ts`. Nothing in the repo, the README, the docs site or the `/captain`
skill ever imported it, and no usage was documented anywhere — so it was 31 public
names under semver with no stated contract. The package now ships `bin` only, and
`dist/` is `cli.js` alone.

**Breaking:** `import { … } from "cmux-captain"` no longer resolves. The `captain`
command is unaffected. If you were importing it, open an issue — the surface can
come back documented and deliberate rather than incidental.
