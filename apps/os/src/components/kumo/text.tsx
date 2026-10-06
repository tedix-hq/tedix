import { Text as KumoText } from "@cloudflare/kumo/components/text";
import type { ComponentPropsWithoutRef, ElementRef, ForwardedRef } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * Why this adapter exists
 * -----------------------
 * OS owns its own type scale — the six semantic roles
 * `--text-tedix-caption|label|control|body|section|dialog` and the matching
 * `.type-tedix-*` classes in `@tedix/design-tokens/kumo.css`. Every other Kumo
 * adapter pins its control to one of those roles, so until now the only way for
 * feature code to reach a Tedix type role was *through a control*. Plain text
 * had no named role at all, which is why the app accumulated hundreds of raw
 * `text-xs`/`text-sm` (and `text-[9px]`) utilities that drift away from the
 * scale one file at a time.
 *
 * `Text` closes that gap: it names a Tedix role on ordinary prose, headings,
 * captions, and metadata while keeping Kumo's semantic colour variants, its
 * `as` polymorphism, and its truncation behaviour.
 *
 * When to use it
 * --------------
 * Any static text that is not already inside a Kumo adapter that owns its own
 * type role (`Badge`, `CardTitle`, `Input`, tabs, …). Prefer this over a raw
 * `<p className="text-sm">` / `<span className="text-xs text-kumo-subtle">`.
 * Do not use it to restyle a control's label — that role belongs to the
 * control's own adapter.
 *
 * How the size override works (read before changing it)
 * -----------------------------------------------------
 * Kumo's `Text` always emits one of its own size utilities (`text-xs`
 * … `text-lg`) and offers no way to suppress it; `size` is also typed
 * per-variant (monospace variants only accept `"lg"`), so it is not a usable
 * escape hatch. The `.type-tedix-*` classes declare `font-size` and
 * `line-height` with `!important`, and CSS `!important` beats an ordinary
 * declaration regardless of source order or specificity. So we **compose**
 * rather than override: we never pass `size`, we let Kumo emit its default
 * size utility alongside its variant colour/family classes, and we append the
 * `.type-tedix-*` role class, which wins on font-size and line-height while
 * Kumo keeps colour, font-family and truncation. The residual `text-base` in
 * the DOM is inert. This is the same composition `badge.tsx` and `input.tsx`
 * already rely on.
 */

type TextElement = NonNullable<ComponentPropsWithoutRef<typeof KumoText>["as"]>;

/** The Tedix semantic type roles, in ascending size order. */
type TextRole =
	| "caption"
	| "label"
	| "control"
	| "body"
	| "section"
	| "dialog"
	| "title"
	| "metric";

/**
 * Semantic colour/family, mapped onto Kumo's own `Text` variants. Tone carries
 * meaning (muted, success, error, code) — never size.
 */
type TextTone =
	| "default"
	| "secondary"
	| "success"
	| "error"
	| "mono"
	| "mono-secondary"
	| "strong"
	| "warning";

type TextWeight = "normal" | "medium" | "semibold";

const ROLE_CLASS: Record<TextRole, string> = {
	caption: "type-tedix-caption",
	label: "type-tedix-label",
	control: "type-tedix-control",
	body: "type-tedix-body",
	section: "type-tedix-section",
	dialog: "type-tedix-dialog",
	title: "type-tedix-title",
	metric: "type-tedix-metric",
};

/*
 * Kumo's copy variants are exactly `body | secondary | success | error`, so
 * `strong` and `warning` have no upstream equivalent and are composed here
 * instead. They exist because feature code kept reaching for them anyway:
 * `text-kumo-strong` and `text-kumo-warning` accounted for most of the sites
 * that could otherwise have been a plain `Text` call. Absorbing them is what
 * stops a colour class riding along beside a role — the same bypass habit that
 * produced the raw-utility debt in the first place.
 */
const TONE_CLASS: Partial<Record<TextTone, string>> = {
	strong: "text-kumo-strong",
	warning: "text-kumo-warning",
	/*
	 * `success` is composed here too, and NOT delegated upstream, because Kumo
	 * 2.12.0's own `success` variant is mislabelled: its table reads
	 * `success: { classes: "text-kumo-link", description: "Success state text" }`
	 * — the BRAND/LINK colour, not the status green. Passing tone="success"
	 * through would render every success state in the accent hue, which is both
	 * wrong and invisible in review: the prop name, the description and the
	 * rendered colour all disagree, and only the last one is true.
	 * Re-check on the next Kumo bump; if upstream fixes the variant, this entry
	 * can go back to KUMO_TONES.
	 */
	success: "text-kumo-success",
};

/** Tones Kumo renders itself; everything else falls back to its `body` variant. */
const KUMO_TONES = new Set<TextTone>([
	"secondary",
	"error",
	"mono",
	"mono-secondary",
]);

// Kumo's `bold` prop is typed as `never` on the monospace and heading variants
// and resolves to exactly `font-medium` on the copy variants. One uniform
// `weight` prop mapped to the same utilities gives every tone the same control
// without reimplementing anything Kumo does.
const WEIGHT_CLASS: Record<TextWeight, string | false> = {
	normal: false,
	medium: "font-medium",
	semibold: "font-semibold",
};

interface TextProps extends Omit<
	ComponentPropsWithoutRef<typeof KumoText>,
	"variant" | "size" | "bold" | "as" | "DANGEROUS_className" | "DANGEROUS_style"
> {
	/** Tedix type role. Defaults to `"body"` (14/20). */
	role?: TextRole;
	/** Semantic colour/family. Defaults to `"default"`. */
	tone?: TextTone;
	/** Font weight. Defaults to `"normal"`. */
	weight?: TextWeight;
	/**
	 * Element override. Kumo defaults to `<p>` for copy tones and `<span>` for
	 * monospace tones — pass `h1`–`h6` when the text belongs in the document
	 * outline.
	 */
	as?: TextElement;
	/** Truncate overflow with an ellipsis (adds Kumo's `min-w-0 truncate`). */
	truncate?: boolean;
	/** Layout/colour utilities. Merged after the role class. */
	className?: string;
}

const Text = forwardRef(function Text(
	{
		role = "body",
		tone = "default",
		weight = "normal",
		as,
		truncate,
		className,
		...props
	}: TextProps,
	ref: ForwardedRef<ElementRef<"span">>,
) {
	return (
		<KumoText
			ref={ref}
			variant={KUMO_TONES.has(tone) ? (tone as "secondary") : "body"}
			as={as}
			truncate={truncate}
			data-slot="text"
			DANGEROUS_className={cn(
				ROLE_CLASS[role],
				TONE_CLASS[tone],
				WEIGHT_CLASS[weight],
				className,
			)}
			{...props}
		/>
	);
});

export {
	Text,
	type TextElement,
	type TextProps,
	type TextRole,
	type TextTone,
	type TextWeight,
};
