import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/*
 * Generic geometry adapter. The shimmer is genuinely Kumo's, but it arrives as
 * a stylesheet rule rather than an import: `.skeleton` and its `@keyframes
 * skeleton` live in `@cloudflare/kumo/styles/kumo.css`, which the OS loads via
 * the `@cloudflare/kumo/styles/tailwind` import in `src/kumo-tedix.css`. That
 * rule is unlayered, so its `background` shorthand paints the sweep and resets
 * the layered `bg-kumo-fill` utility to transparent. Preserve Kumo's
 * theme-adaptive fill token as an inline longhand underneath the gradient;
 * callers can still override it through `style`. Nothing here to import — do
 * not "fix" this file by reaching for a Kumo component that does not exist.
 * The app-wide `prefers-reduced-motion` block in `src/styles.css` stops the
 * sweep, which is why no `motion-reduce` utility appears below.
 */
function Skeleton({ className, style, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn("skeleton rounded-lg bg-kumo-fill", className)}
			style={{ backgroundColor: "var(--color-kumo-fill)", ...style }}
			{...props}
		/>
	);
}

export { Skeleton };
