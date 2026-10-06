"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const badgeVariants = cva(
	"group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border border-transparent font-medium transition-all transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/80",
				soft: "bg-primary/10 text-primary focus-visible:ring-primary/20 dark:bg-primary/20 dark:focus-visible:ring-primary/40 [a&]:hover:bg-primary/20",
				secondary:
					"bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80",
				destructive:
					"bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/20",
				outline:
					"border-border bg-input/30 text-foreground [a&]:hover:bg-muted [a&]:hover:text-muted-foreground",
				ghost:
					"hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
				link: "text-primary underline-offset-4 hover:underline",
				success:
					"bg-success/10 text-success dark:text-success [a&]:hover:bg-success/20",
				warning:
					"bg-warning/10 text-warning dark:text-warning [a&]:hover:bg-warning/20",
				info: "bg-info/10 text-info dark:text-info [a&]:hover:bg-info/20",
				discovery:
					"bg-discovery/10 text-discovery dark:text-discovery [a&]:hover:bg-discovery/20",
				caution:
					"bg-caution/10 text-caution dark:text-caution [a&]:hover:bg-caution/20",
				rating:
					"border-transparent bg-amber-500 text-white shadow-sm [&>svg]:fill-current",
				price: "border-transparent bg-muted font-normal text-muted-foreground",
				// Overlay variants - for badges on images (TheFork/Booking.com style)
				overlay:
					"border-transparent bg-black/70 text-white shadow-sm backdrop-blur-sm",
				"overlay-light":
					"border-transparent bg-white/90 text-foreground shadow-sm backdrop-blur-sm dark:bg-black/80 dark:text-white",
			},
			size: {
				sm: "h-4 px-1.5 py-0.5 text-[10px] has-[[data-icon=inline-end]]:pr-1 has-[[data-icon=inline-start]]:pl-1 [&>svg]:size-2.5",
				md: "h-5 px-2.5 py-0.5 text-xs has-[[data-icon=inline-end]]:pr-1.5 has-[[data-icon=inline-start]]:pl-1.5 [&>svg]:size-3",
				lg: "h-6 px-3 py-1 text-sm has-[[data-icon=inline-end]]:pr-2 has-[[data-icon=inline-start]]:pl-2 [&>svg]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "soft",
			size: "sm",
		},
	},
);

export interface BadgeProps
	extends useRender.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
	/**
	 * Whether to render the badge with fully rounded corners (pill shape)
	 * @default false
	 */
	pill?: boolean;
}

/**
 * Badge - Base UI badge primitive with apps-sdk-ui theming
 *
 * Uses useRender pattern for flexible rendering (can be span, a, button, etc.)
 *
 * @example
 * ```tsx
 * <Badge>Default</Badge>
 * <Badge variant="secondary">Secondary</Badge>
 * <Badge variant="outline">Outline</Badge>
 * <Badge variant="destructive">Error</Badge>
 * <Badge variant="success">Success</Badge>
 * <Badge variant="warning">Warning</Badge>
 * <Badge variant="info">Info</Badge>
 * <Badge size="sm">Small</Badge>
 * <Badge size="lg">Large</Badge>
 * <Badge render={<a href="/link" />}>Link Badge</Badge>
 *
 * // Image overlay badges (TheFork/Booking.com style)
 * <Badge variant="overlay">12 photos</Badge>
 * <Badge variant="overlay-light">Featured</Badge>
 * <Badge variant="rating"><Star /> 4.8</Badge>
 * ```
 */
function Badge({
	className,
	variant = "soft",
	size = "sm",
	pill = false,
	render,
	...props
}: BadgeProps) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(
					badgeVariants({ variant, size }),
					pill ? "rounded-full" : "rounded-md",
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
			size,
		},
	});
}

// Export type-safe size variants
export type BadgeSize = NonNullable<VariantProps<typeof badgeVariants>["size"]>;
export type BadgeVariant = NonNullable<
	VariantProps<typeof badgeVariants>["variant"]
>;

export { Badge, badgeVariants };
