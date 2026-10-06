# Marketing starter

CTA-driven landing + blog. The original — and current default — Tedix CMS starter. Optimized for go-to-market sites with hero + comparison + pricing + lead-capture blocks. SEO/AEO emission is locked, branding is platform-driven.

Components shipped under `src/components/`:

- `HeroSection.astro` — centered / split hero with eyebrow, dual CTAs, optional image.
- `ComparisonTable.astro` — schema.org/Table competitor / tier comparison.
- `PricingBlock.astro` — tier card grid with featured highlight + `OfferCatalog` JSON-LD.
- `LeadCaptureForm.astro` — Native Forms embed. Fields, required consent, button/confirmation copy and notifications are configured in Forms. Attribution requires configured hidden source/UTM fields.
- `AuthorByline.astro`, `PostCard.astro`, `FaqSection.astro` — shared content surfaces.

Includes the `emprivacy` plugin only when `PRIVACY_BANNER_ENABLED=true`. Configure copy and category scripts in the Emdash admin under the shield icon → EmPrivacy. Leave it disabled for tenants that rely on their primary site's privacy/cookie layer.

Newsletter double opt-in remains separate from native Forms submissions.
