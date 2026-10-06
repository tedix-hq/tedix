# Marketing template

The `marketing` starter adds a full marketing site to the Tedix Emdash blog
template. It is selected through `apps.metadata.blogConfig.templateSlug` and
copied to each new tenant. Existing tenant content and active Artifacts themes
do not change when this starter changes.

The seed defines the `pages` collection with native, versioned blocks in
`pages.content`. `src/pages/index.astro` renders the published `home` entry;
`src/pages/[slug].astro` renders other published pages. Both require a nonempty
native block composition. `MarketingBlocks.astro` passes the ordered values to
Emdash's `<Blocks>` renderer with a direct generated-type component map.
Each section consumes its stored fields without a recursive key adapter. The `marketing_prose`
block contains Portable Text for rich prose inside that native composition.

The available native block types are `marketing_hero`, `marketing_features`,
`marketing_stats`, `marketing_cta`, `marketing_logo_strip`,
`marketing_text_with_image`, `marketing_testimonials`, `marketing_pricing`,
`marketing_faq`, and `marketing_prose`. Editors compose and publish them through
the `pages` collection. A new visual section needs a block definition in the
seed, an Astro component, and a mapping in `MarketingBlocks.astro`.
Prose and articles use native `<PortableText>` so installed plugin embeds and
authenticated inline editing share the CMS renderer. Markdown export stays separate.

The starter also supplies menu-driven marketing chrome, contact/forms, the
blog, native Emdash sitemap and robots routes, and `/llms.txt`. The latter links
marketing pages to HTML and posts to their Markdown route. Emdash's native
sitemap lists published collection entries; a custom index route needs a
published entry if it must appear there.

Run `bun run build` in this directory to check the standalone theme. For the
embedded Site Builder snapshot, run `bun run snapshot:template` and
`bun run type-check` in `apps/cms` after changing the starter.
