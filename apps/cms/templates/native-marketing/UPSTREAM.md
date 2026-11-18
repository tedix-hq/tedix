# Native marketing scaffold

Presentation and block schemas copied from emdash-cms/emdash commit
00e535a030d49f43e291ed59b7be30fdc466c698, `templates/marketing-cloudflare`
(upstream main checked 18 November 2026).

Includes all 11 marketing block renderers, PageView, generic `[slug]` pages,
the `/home` redirect, layout, styles and presentation utilities. The unused
upstream block re-export file is omitted; components use direct imports.
Tedix files continue to supply hosting, authentication and trusted plugins.
The Astro config keeps that platform integration and adopts upstream fonts
and the explicit icon list, preserving native `light-dark()` CSS.

Seed schemas and collection routing apply only when scaffolding a fresh site.
Existing sites' stored schemas are not migrated. Sample content stays in drafts
with clearly labelled examples instead of upstream customer and product claims.

[Fresh-database checks](../../src/template-scaffold.test.ts) apply each scaffold
with the native CLI and run doctor. [Render checks](../../tests-render/native-marketing.render.ts)
render every seeded block version with the Astro container and check PageView.

Run `bun run --cwd apps/cms test:render` for render checks; CMS `test:ci`
also runs them. Fresh-site tests retain external media URLs with `--skip-media`
so validation does not depend on third-party downloads.
