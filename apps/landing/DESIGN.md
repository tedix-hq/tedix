# Tedix Landing Page — Design System

> Global Tedix design-system decisions live in `../../docs/engineering/product/design.md`. This file
> only owns Landing-specific marketing composition, page sections, imagery,
> animations, and copy rhythm. When the two disagree on cross-surface tokens or
> runtime ownership, update `../../docs/engineering/product/design.md` and keep this file local.
>
> This file is the source of truth for any AI agent (Claude Code, Codex)
> working on the Tedix landing app. Read this before writing any UI code.

---

## Brand Identity

**Company**: Tedix — AI digital workers for business
**Tone**: Professional but human. Enterprise-grade without being corporate stiff. Warm, confident, approachable.
**Audience**: Corporate decision-makers, enterprise teams, founders who need AI that works.

---

## Color Palette

The token layer in `src/styles/globals.css` is the source of truth for color —
read it before hardcoding a value here or in a component. The load-bearing
facts:

### Primary — Magenta (brand signature)

`--primary` and `--brand` are magenta: `oklch(0.59 0.26 323)` in light mode,
`oklch(0.67 0.26 322)` in dark mode. The chart ramp (`--chart-1`…`--chart-5`)
is a magenta lightness scale around the same hue. `--highlight` is a warm
yellow reserved for text highlights.

### Supporting hues (composition, not tokens)

Marketing sections composite with Tailwind violet/fuchsia plus an orange
terminus in hero gradients (`from-violet-600 via-fuchsia-500 to-orange-500`).
Rose and fuchsia appear as card badge accents. Amber/orange utility classes
survive only in older sections (Navbar, linktree pages, parts of HomePage) —
do not extend them into new work; prefer `--primary`/violet-family classes.

### Dark sections

Deep violet-black backdrops (`#080016`, `#0c0020`, `#0a0012`) with violet grid
lines and glows; the landing theme block in `globals.css` owns the semantic dark
tokens.

### Gradients (use these, don't invent new ones)

- **Hero text**: `bg-gradient-to-r from-violet-600 via-fuchsia-500 to-orange-500` (dark: 400-weights)
- **Primary CTA (ShimmerButton)**: `linear-gradient(135deg, #7c3aed, #c026d3, #ea580c)`
- **Section backdrops**: violet-50 → background fades; dark sections fade between the deep violet-blacks above

---

## Typography

### Font Stack

- **Display/Headings**: `Comfortaa` (rounded, approachable — `font-display` class)
- **Body**: `Raleway` (clean, professional — `font-sans` class)
- **Mono**: `Geist Mono` (code blocks — `font-mono` class)

### Scale

- **Hero H1**: `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` — big, bold, no more than 3 lines
- **Section H2**: `text-3xl md:text-4xl lg:text-5xl` — always with `font-display font-bold tracking-tight`
- **H3 (cards)**: `text-xl md:text-2xl` — `font-display font-bold`
- **Body**: `text-base md:text-lg` — `leading-relaxed`
- **Small/labels**: `text-xs uppercase tracking-[0.2em] font-medium`

### Rules

- Section eyebrows use accent uppercase: `text-violet-600 text-sm uppercase tracking-[0.2em]` (some sections vary the hue, e.g. orange for use cases)
- Never use more than 2 heading sizes in one section
- Body text max-width: `max-w-md` in hero, `max-w-xl` in sections, `max-w-2xl` for wider

---

## Spacing

- **Section padding**: `py-24 md:py-32` (consistent vertical rhythm)
- **Container**: `container mx-auto px-4`
- **Content max-width**: `max-w-4xl` (most sections), `max-w-5xl` (bento, tech flow), `max-w-6xl` (full-width grids)
- **Card padding**: `p-8 md:p-10`
- **Grid gap**: `gap-4 md:gap-6` (cards), `gap-8 md:gap-12` (major sections)

---

## Component Patterns

The public Apps route family (`/apps/`, `/apps/insights/`, and app detail
pages) composes cards, badges, buttons, inputs, selects, progress
visualizations, empty states, and operational tables through the shared
Kumo-backed adapters in `src/components/ui/`. Motion remains landing-owned and must honor
reduced-motion preferences; decorative glow-card wrappers are not part of the
catalog grammar.

### Cards

Use `Card`, `CardHeader`, `CardContent`, and `CardFooter` from `@/components/ui/card`
for reusable content and product surfaces. Apply local classes only for the
marketing context's spacing, color, and responsive composition. Narrative
figures, editorial illustrations, and branded simulations stay landing-owned.

### Dark Cards (in dark sections)

Use the same shared `Card` primitives with dark-section color overrides. A dark
theme is not a reason to recreate card structure, borders, or accessibility.

### Buttons

- Use `Button` for React islands and `buttonVariants` for Astro-rendered links
  and buttons.
- Preserve the shared focus, touch-target, disabled, and reduced-motion
  behavior; local classes may supply campaign-specific color or shape.
- Reserve `ShimmerButton` for an intentional, singular hero treatment rather
  than ordinary actions.

### Badges

Use `Badge` from `@/components/ui/badge`. Select the semantic variant first, then add
campaign color only where it communicates a real category or status.

### Trust Strip

```
flex flex-wrap gap-x-4 gap-y-2 text-xs font-medium text-muted-foreground
```

Items: 🔒 GDPR Compliant • 🇩🇪 Made in Germany • 🏢 Enterprise-Ready • ✅ Auditable AI

---

## Motion and Animation

These landing-owned components are available for purposeful storytelling. They
are not substitutes for shared controls or a default decoration layer:

| Component              | Use For                                                  |
| ---------------------- | -------------------------------------------------------- |
| `BlurFade`             | Entrance animations (direction="up", stagger with delay) |
| `Particles`            | Ambient background particles (hero, dark sections)       |
| `ShimmerButton`        | Primary CTAs                                             |
| `AnimatedGradientText` | Highlighted punchlines                                   |
| `Marquee`              | Logo carousels                                           |
| `NumberTicker`         | Stats counters                                           |
| `AnimatedBeam`         | Connection lines in tech flow diagrams                   |
| `BorderBeam`           | Card highlight borders                                   |
| `TextAnimate`          | Text entrance effects                                    |

### Animation Rules

- Use `client:idle` for above-fold animations (not `client:only`)
- Use `client:visible` for below-fold sections
- Do not pulse, shimmer, float, or continuously animate idle product surfaces.
- Every transition and animation must have an effective reduced-motion path.
- Use `client:only="react"` ONLY for heavy components that can't SSR (particles, complex state)
- Stagger BlurFade delays by 0.1-0.15s increments
- Keep all animations under 3s duration
- Respect `prefers-reduced-motion` (already handled in globals.css)

---

## Visual Design Principles

### DO

- **Use real images for editorial/artistic visuals** — AI-generated or commissioned. Code-generated SVG cannot produce the textured, painterly quality needed.
- **Use real brand SVG logos** — never emoji or text placeholders in production.
- **Dark backgrounds for dramatic sections** — hero and key feature sections use navy (#0a0a1a).
- **Warm ambient glows** — subtle amber/orange gradient blobs at 8-15% opacity with 80-150px blur.
- **Show the human element** — human silhouette + AI brain = powerful visual metaphor for the product.

### DON'T

- ❌ Don't use emoji (✉️📊☁️) as icons in production — they cheapen the design instantly.
- ❌ Don't generate artistic illustrations in SVG code — they look flat and technical. Use real images.
- ❌ Don't make diagrams that look like wireframes — even technical sections need visual warmth.
- ❌ Don't use more than 60% of hero width for text — the illustration needs space to breathe.
- ❌ Don't use pure black (#000) — use navy (#0a0a1a) or stone (#0c0a09) for dark sections.

### The Visual Feedback Loop

When working on visual changes:

1. Generate the code change
2. Deploy or run dev server
3. **Screenshot the result** (use firecrawl or CDP)
4. **Analyze the screenshot** with an available image-capable model
5. Compare against reference images or design intent
6. Iterate if quality is below threshold
7. NEVER ship without visually verifying

---

## Page Sections (Current Structure)

1. **Hero** — Dark navy, text left (40%) + editorial illustration right (60%)
2. **Problem** — Light bg, 3 pain cards
3. **Solution** — Light/warm, 3 value columns
4. **How It Works** — Dark bento grid (Day 1 → Month 3)
5. **Tech Flow** — Light, animated beam diagram with real logos
6. **Use Cases** — Alternating light/dark cards with testimonials
7. **Logo Bar** — AI platform marquee
8. **Economics** — Dark, 4 cards explaining cost reduction
9. **Trust** — Light, 3 columns (GDPR, Auditable, Owned)
10. **Platforms** — Light, animated beams + stats
11. **Backers** — Light, logo bar
12. **Access CTA** — Dark, invite-only signals + Descope signup CTA
13. **Blog** — server:defer island (existing)

### Section Pattern

Every section follows:

```
<section class="py-24 md:py-32"> or bg-[#0c0a09] for dark
  <div class="container mx-auto px-4">
    <div class="mx-auto max-w-{size}">
      <!-- Section label (amber uppercase) -->
      <!-- H2 (font-display, bold, tracking-tight) -->
      <!-- Content -->
    </div>
  </div>
</section>
```

---

## Image Assets

| Path                                       | Description                                          |
| ------------------------------------------ | ---------------------------------------------------- |
| `/images/hero-brain.png`                   | Hero editorial illustration (AI-generated, 3MB)      |
| `/images/tedi-astronaut-waving.png`        | Mascot (navbar logo only, 28px)                      |
| `/images/apps/*.svg`                       | AI platform logos (OpenAI, Anthropic, Google, etc.)  |
| `/images/tools/*.svg`                      | Productivity tool logos (Notion, Gmail, Slack, etc.) |
| `/images/logos/klarna.svg`                 | Klarna partner logo                                  |
| `/images/testimonials/martin-andersen.jpg` | Klarna testimonial photo                             |
| `/images/backers/`                         | Backer logos (TODO: real SVGs needed)                |
| `/images/clients/`                         | Client logos (TODO: real SVGs needed)                |

---

## Tech Stack Reference

- **Framework**: Astro 7 on Vite 8 (SSR on Cloudflare Workers via `@astrojs/cloudflare` 14)
- **React Islands**: Interactive components use React 19 (`@astrojs/react` 6)
- **CSS**: Tailwind CSS v4 via `@tailwindcss/vite`
- **UI Library**: app-local Kumo adapters (`src/components/ui/`) over `@tedix/design-tokens`
- **Motion**: Landing-owned MagicUI compositions + Motion, used selectively
- **Fonts**: Astro Fonts API (Google Fonts: Raleway + Comfortaa)
- **Build**: `bun run build` (local build; managed deployment belongs to the private ops repository)
