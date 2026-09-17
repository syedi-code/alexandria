# alexandria

One backend serving two frontends. Hono on Cloudflare Workers, one D1, one R2,
everything under `/api/`.

**Read `CLAUDE.md` first.** It is the working guide and it is kept current;
this file exists because spec-kit regenerates it and would otherwise describe
a project structure that does not exist.

## The rule that matters

`packages/core/` splits into `works/`, `writing/` and `platform/`. Writing may
import Works. Works may not import Writing. Platform may import neither.
Nothing fails at runtime when you cross that line — `no-restricted-imports` in
`eslint.config.mjs` is what holds it.

## Commands

```bash
npm run dev     # worker against local SQLite
npm test        # vitest
npm run lint    # eslint, including the boundary rule
npm run deploy  # wrangler deploy
```

## Style

TypeScript 5.9, strict where it is on. Follow the surrounding code. Be
extremely light on comments; only add one where the intent is not obvious from
reading the code itself.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
