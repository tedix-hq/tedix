import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { type ComponentProps, type ElementType, createElement } from "react";
import { cn } from "../../lib/utils";

/**
 * Why this adapter exists
 * -----------------------
 * `docs/engineering/product/design.md` mandates three persistent surface levels — canvas,
 * bounded surface, overlay — but only the composed card (`card.tsx`) was
 * adapted. Anything that needed a plain bounded box with no header/content/
 * footer rhythm reached for ad-hoc `bg-kumo-*` + `border-*` + `rounded-*`
 * utilities instead, which is where the surface-token drift comes from.
 *
 * `Surface` is that missing level: a token-backed bounded box that owns
 * background, semantic line, radius, and elevation, and nothing else. It has
 * no padding and no internal layout, so it composes under anything.
 *
 * Which Kumo component this is built on
 * -------------------------------------
 * NOT Kumo's `Surface` from `@cloudflare/kumo/components/surface`: in v2.12.0
 * that component is `@deprecated` and is itself only a compatibility wrapper
 * that forwards to `LayerCard` (its `as` prop is separately deprecated in
 * favour of `render`). This adapter therefore targets `LayerCard` directly —
 * the same non-deprecated primitive `card.tsx` uses — and keeps the polymorphic
 * `as`/`render` surface the deprecated wrapper offered.
 *
 * When to use it
 * --------------
 * - `Surface` — a bounded region that is not a record card: a preview frame, a
 *   panel, a well, a diff pane, an inline editor chrome. Pick its tier below.
 * - `Card` (`card.tsx`) — a record/settings card, when you want the shared
 *   header/content/footer rhythm.
 * - Dialogs, sheets, popovers, and menus own their own overlay elevation
 *   tokens; do not build one out of `Surface`.
 *
 * Two tiers: `tier="panel"` vs `tier="well"`
 * -----------------------------------------
 * The card tier exists because a card must read as a *layer above* the
 * controls it contains (`docs/engineering/product/design.md`, "Radii"). That reasoning
 * only holds for a box that is itself a top-level layer. A box nested *inside*
 * a card is not a layer above the controls it contains — it is a recess in the
 * layer that already exists — so it stays on the control tier. Hence:
 *
 * - `tier="panel"` — a **top-level bounded surface**: it sits directly on the
 *   page canvas and is a peer of a `Card`. Card tier, `rounded-xl`
 *   (`--radius-xl` = `calc(var(--radius) + 4px)` = 12px).
 * - `tier="well"` (default) — a **nested well**: a bounded region inside a
 *   card or another surface. A payload box, a diff pane, an evidence frame, a
 *   code well. Control tier, `rounded-lg` (`--radius` = 8px).
 *
 * The tier moves geometry only. Both tiers paint the one surface token
 * (`bg-kumo-base`): the restrained Console treatment lets the semantic line
 * carry the grouping, so a well does not need its own fill step to read as
 * bounded, and one token is what ends the drift described below.
 *
 * The default is `"well"` because it is the safe failure: an unqualified
 * `<Surface>` that should have been a panel merely looks flat, whereas a card
 * tier granted to a nested box breaks the layering rule the split exists to
 * protect — and nested wells are the large majority of bounded boxes in OS.
 * Promote to `tier="panel"` deliberately, at a call site that sits on canvas.
 *
 * Why this is a separate prop and not a `variant` value
 * ----------------------------------------------------
 * `variant` means **elevation tone** (`flat` / `raised`); `tier` means
 * **geometry and nesting role**. They are orthogonal: a raised well and a flat
 * top-level panel are both legitimate, and folding them into one enum would
 * force a call site to pick a tone in order to state a radius (or the reverse)
 * and collapse four valid states into two wrong ones.
 *
 * Background is adapter-owned
 * ---------------------------
 * `Surface` owns background, border, radius and elevation; call sites keep
 * layout only (width, padding, grid, overflow). Do not restate a `bg-kumo-*`
 * at a call site — the token drift this adapter exists to end
 * (`fill`/`tint`/`base`/`control`/`recessed` all used for one role) came from
 * exactly that.
 *
 * `variant="raised"` is the "changed layer" tone (an active composition, a
 * raised preview) and uses `shadow-tedix-raised`, matching `Card`'s
 * `tone="raised"`. Default is flat, per the restrained Console treatment.
 */

type SurfaceVariant = "flat" | "raised";
type SurfaceTier = "panel" | "well";

type SurfaceProps = ComponentProps<typeof LayerCard> & {
	/** Elevation tone. Defaults to `"flat"`. */
	variant?: SurfaceVariant;
	/**
	 * Geometry tier. `"panel"` for a top-level bounded surface that is a peer
	 * of a `Card` (12px); `"well"` for a bounded region nested inside a card or
	 * another surface (8px). Defaults to `"well"`.
	 */
	tier?: SurfaceTier;
	/**
	 * Element override, kept for parity with the deprecated Kumo `Surface`.
	 * Prefer Base UI's `render` when you need to compose with a component
	 * rather than swap the tag.
	 */
	as?: ElementType;
};

function Surface({
	as,
	className,
	render,
	tier = "well",
	variant = "flat",
	...props
}: SurfaceProps) {
	return (
		<LayerCard
			data-slot="surface"
			data-tier={tier}
			data-variant={variant}
			render={render ?? (as ? createElement(as) : undefined)}
			className={cn(
				"min-w-0 border border-kumo-line bg-kumo-base shadow-none! ring-0",
				tier === "panel" ? "rounded-xl" : "rounded-lg",
				"data-[variant=raised]:bg-kumo-elevated data-[variant=raised]:shadow-tedix-raised!",
				className,
			)}
			{...props}
		/>
	);
}

export { Surface, type SurfaceProps, type SurfaceTier, type SurfaceVariant };
