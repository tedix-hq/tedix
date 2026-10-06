import {
	Link as KumoLink,
	type LinkProps as KumoLinkProps,
} from "@cloudflare/kumo/components/link";
import { buttonVariants } from "./button";
import { cn } from "./cn";

/**
 * OS link roles.
 *
 * Presentational only — routing comes from the app-level `KumoLinkProvider`
 * (see `./link-provider`), which maps `href` onto TanStack Router, so call
 * sites keep using plain `href`.
 *
 * Kumo ships three variants (`inline`, `current`, `plain`). OS adds two product
 * roles on top of them, because the Console draws lines the Kumo set does not:
 *
 * - `"inline"` (Kumo default) — a genuine hyperlink. Prose links, and a
 *   *secondary* destination shown beside a record (the route URL underneath a
 *   Worker's name). Brand-coloured and underlined at rest, because nothing
 *   around it advertises that it is clickable.
 * - `"current"` / `"plain"` (Kumo) — pass-through. Inherit the surrounding
 *   colour, or drop the underline, without taking on a product role.
 * - `"record"` (OS) — the **navigable title of a row or card in an operational
 *   table or collection**: a work item's outcome, a project's name, a case
 *   subject, an app's name. The text *is* the record's name; navigating to the
 *   record is what a row title does anyway. So it renders in the surrounding
 *   foreground colour with no resting underline, exactly like a resource name
 *   in the Cloudflare Console. A queue of fifteen rows must read as fifteen
 *   records, not fifteen hyperlinks.
 * - `"section"` (OS) — a **hash destination in a sticky in-page settings
 *   rail**. It stays a genuine anchor, uses compact Console geometry, and
 *   derives its selected treatment from `aria-current="location"`. The role
 *   must not be built from Button: hash navigation needs link semantics,
 *   middle-click/copy-link behavior, and the current-location relationship.
 * - `"navigation"` (OS) — a **route destination in a compact horizontal
 *   navigator**. It borrows Kumo's ghost-button geometry without borrowing
 *   button semantics, and exposes the selected route with `aria-current="page"`.
 * - `"collection"` (OS) — the **navigable body of an operational collection
 *   row** when sibling actions must remain separate controls. It keeps the row
 *   free of resting/hover underlines, adds the quiet tint on hover, and exposes
 *   a single focus boundary around the record destination.
 *
 * Pick `"record"` when the text names the thing the row is about; pick
 * `"inline"` when the text points somewhere else.
 *
 * `"record"` is a colour-and-decoration change, never a downgrade of the
 * affordance: the element stays a real `<a href>` (keyboard focus,
 * middle-click, copy-link-address), takes a pointer cursor, underlines on
 * hover, and shows the shared Kumo focus ring.
 *
 * Prefer this adapter over `Button variant="link"` for links inside prose, and
 * over a raw `<a>` so link colour, underline offset, and the external-link
 * affordance (`<Link.ExternalIcon />`) stay consistent.
 */
type LinkVariant =
	| NonNullable<KumoLinkProps["variant"]>
	| "record"
	| "section"
	| "navigation"
	| "collection";

type LinkProps = Omit<KumoLinkProps, "variant"> & {
	/** @see LinkVariant — `"record"` is the OS row-title role. */
	variant?: LinkVariant;
};

/**
 * Record-role treatment, expressed once.
 *
 * Built on Kumo's `current` variant, which already supplies the inherited
 * foreground colour, the underline geometry, and the `link-current` decoration
 * colour — only the resting decoration has to flip to hover-only.
 *
 * The two decoration utilities are `!important` on purpose. Kumo's Link
 * concatenates its variant classes with the caller's `className` through Base
 * UI `mergeProps` (a plain join, not tailwind-merge), so the cascade decides,
 * and Tailwind emits `.no-underline` *before* `.underline`. A plain
 * `no-underline` therefore loses to the variant. This is the same escape hatch
 * the shell chrome already uses on its user chip.
 */
const RECORD_CLASSES =
	"cursor-pointer rounded-xs no-underline! hover:underline! focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus";

const SECTION_CLASSES =
	"inline-flex h-6 shrink-0 cursor-pointer items-center rounded-sm px-1.5 font-medium text-kumo-default type-tedix-caption no-underline! transition-colors hover:bg-kumo-tint aria-[current=location]:bg-kumo-fill aria-[current=location]:text-kumo-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus max-sm:min-h-11 max-sm:px-3 coarse:min-h-11 coarse:px-3 motion-reduce:transition-none";

const NAVIGATION_CLASSES = cn(
	buttonVariants({ size: "sm", variant: "ghost" }),
	"shrink-0 cursor-pointer no-underline! aria-[current=page]:bg-kumo-fill aria-[current=page]:text-kumo-strong focus-visible:ring-2 focus-visible:ring-kumo-focus",
);

const COLLECTION_CLASSES =
	"inline-flex cursor-pointer items-center rounded-md no-underline! hover:bg-kumo-tint hover:no-underline! focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus motion-reduce:transition-none";

function Link({ className, variant = "inline", ...props }: LinkProps) {
	if (variant === "record") {
		return (
			<KumoLink
				data-slot="link"
				data-link-role="record"
				variant="current"
				className={cn(RECORD_CLASSES, className)}
				{...props}
			/>
		);
	}
	if (variant === "section") {
		return (
			<KumoLink
				data-slot="link"
				data-link-role="section"
				variant="current"
				className={cn(SECTION_CLASSES, className)}
				{...props}
			/>
		);
	}
	if (variant === "navigation") {
		return (
			<KumoLink
				data-slot="link"
				data-link-role="navigation"
				variant="current"
				className={cn(NAVIGATION_CLASSES, className)}
				{...props}
			/>
		);
	}
	if (variant === "collection") {
		return (
			<KumoLink
				data-slot="link"
				data-link-role="collection"
				variant="current"
				className={cn(COLLECTION_CLASSES, className)}
				{...props}
			/>
		);
	}

	return (
		<KumoLink
			data-slot="link"
			variant={variant}
			className={className}
			{...props}
		/>
	);
}

Link.ExternalIcon = KumoLink.ExternalIcon;

export { Link, type LinkProps, type LinkVariant };
