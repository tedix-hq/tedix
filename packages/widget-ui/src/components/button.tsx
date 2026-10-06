"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/utils";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 select-none items-center justify-center gap-[var(--widget-control-gap-md)] whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-sm outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-md)] [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/80",
				solid: "bg-primary text-primary-foreground hover:bg-primary/80",
				soft: "bg-primary/10 text-primary hover:bg-primary/20 focus-visible:border-primary/40 focus-visible:ring-primary/20 dark:bg-primary/20 dark:hover:bg-primary/30",
				outline:
					"border-input bg-input/30 hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost:
					"hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
				link: "text-primary underline-offset-4 hover:underline",
				destructive:
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 dark:hover:bg-destructive/30",
				"soft-destructive":
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
				"soft-success":
					"bg-success/10 text-success hover:bg-success/20 focus-visible:border-success/40 focus-visible:ring-success/20 dark:bg-success/20 dark:text-success dark:hover:bg-success/30",
				"soft-warning":
					"bg-warning/10 text-warning hover:bg-warning/20 focus-visible:border-warning/40 focus-visible:ring-warning/20 dark:bg-warning/20 dark:text-warning dark:hover:bg-warning/30",
				"soft-info":
					"bg-info/10 text-info hover:bg-info/20 focus-visible:border-info/40 focus-visible:ring-info/20 dark:bg-info/20 dark:text-info dark:hover:bg-info/30",
				"soft-discovery":
					"bg-discovery/10 text-discovery hover:bg-discovery/20 focus-visible:border-discovery/40 focus-visible:ring-discovery/20 dark:bg-discovery/20 dark:hover:bg-discovery/30",
				discovery:
					"bg-discovery/10 text-discovery hover:bg-discovery/20 focus-visible:border-discovery/40 focus-visible:ring-discovery/20 dark:bg-discovery/20 dark:hover:bg-discovery/30",
			},
			color: {
				primary: "",
				secondary: "",
				destructive: "",
				success: "",
				warning: "",
				info: "",
				discovery: "",
				caution: "",
			},
			size: {
				default:
					"h-[var(--widget-control-height-md)] gap-[var(--widget-control-gap-md)] px-[var(--widget-control-padding-x-md)] has-[[data-icon=inline-end]]:pr-[var(--widget-control-padding-x-sm)] has-[[data-icon=inline-start]]:pl-[var(--widget-control-padding-x-sm)]",
				xs: "h-[var(--widget-control-height-xs)] gap-[var(--widget-control-gap-xs)] px-[var(--widget-control-padding-x-xs)] text-xs has-[[data-icon=inline-end]]:pr-[var(--widget-control-padding-x-xs)] has-[[data-icon=inline-start]]:pl-[var(--widget-control-padding-x-xs)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-xs)]",
				sm: "h-[var(--widget-control-height-sm)] gap-[var(--widget-control-gap-sm)] px-[var(--widget-control-padding-x-sm)] has-[[data-icon=inline-end]]:pr-[var(--widget-control-padding-x-xs)] has-[[data-icon=inline-start]]:pl-[var(--widget-control-padding-x-xs)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-sm)]",
				lg: "h-[var(--widget-control-height-lg)] gap-[var(--widget-control-gap-md)] px-[var(--widget-control-padding-x-lg)] has-[[data-icon=inline-end]]:pr-[var(--widget-control-padding-x-md)] has-[[data-icon=inline-start]]:pl-[var(--widget-control-padding-x-md)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-lg)]",
				// CTA size - prominent call-to-action (TheFork/Booking.com style)
				cta: "h-[var(--widget-control-height-cta)] gap-[var(--widget-control-gap-lg)] px-[var(--widget-control-padding-x-cta)] font-semibold text-base shadow-sm has-[[data-icon=inline-end]]:pr-[var(--widget-control-padding-x-lg)] has-[[data-icon=inline-start]]:pl-[var(--widget-control-padding-x-lg)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-lg)]",
				icon: "size-[var(--widget-control-height-md)]",
				"icon-xs":
					"size-[var(--widget-control-height-xs)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-xs)]",
				"icon-sm":
					"size-[var(--widget-control-height-sm)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-sm)]",
				"icon-lg":
					"size-[var(--widget-control-height-lg)] [&_svg:not([class*='size-'])]:size-[var(--widget-control-icon-lg)]",
			},
		},
		compoundVariants: [
			// Solid variants with colors
			{
				variant: ["default", "solid"],
				color: "primary",
				className: "bg-primary text-primary-foreground hover:bg-primary/80",
			},
			{
				variant: ["default", "solid"],
				color: "secondary",
				className:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80",
			},
			{
				variant: ["default", "solid"],
				color: "destructive",
				className:
					"bg-destructive text-destructive-foreground hover:bg-destructive/80",
			},
			{
				variant: ["default", "solid"],
				color: "success",
				className: "bg-success text-success-foreground hover:bg-success/80",
			},
			{
				variant: ["default", "solid"],
				color: "warning",
				className: "bg-warning text-warning-foreground hover:bg-warning/80",
			},
			{
				variant: ["default", "solid"],
				color: "info",
				className: "bg-info text-info-foreground hover:bg-info/80",
			},
			{
				variant: ["default", "solid"],
				color: "discovery",
				className:
					"bg-discovery text-discovery-foreground hover:bg-discovery/80",
			},
			{
				variant: ["default", "solid"],
				color: "caution",
				className: "bg-caution text-caution-foreground hover:bg-caution/80",
			},
			// Soft variants with colors
			{
				variant: "soft",
				color: "primary",
				className:
					"bg-primary/10 text-primary hover:bg-primary/20 focus-visible:border-primary/40 focus-visible:ring-primary/20 dark:bg-primary/20 dark:hover:bg-primary/30",
			},
			{
				variant: "soft",
				color: "secondary",
				className:
					"bg-secondary/10 text-secondary hover:bg-secondary/20 focus-visible:border-secondary/40 focus-visible:ring-secondary/20 dark:bg-secondary/20 dark:hover:bg-secondary/30",
			},
			{
				variant: "soft",
				color: "destructive",
				className:
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
			},
			{
				variant: "soft",
				color: "success",
				className:
					"bg-success/10 text-success hover:bg-success/20 focus-visible:border-success/40 focus-visible:ring-success/20 dark:bg-success/20 dark:text-success dark:hover:bg-success/30",
			},
			{
				variant: "soft",
				color: "warning",
				className:
					"bg-warning/10 text-warning hover:bg-warning/20 focus-visible:border-warning/40 focus-visible:ring-warning/20 dark:bg-warning/20 dark:text-warning dark:hover:bg-warning/30",
			},
			{
				variant: "soft",
				color: "info",
				className:
					"bg-info/10 text-info hover:bg-info/20 focus-visible:border-info/40 focus-visible:ring-info/20 dark:bg-info/20 dark:text-info dark:hover:bg-info/30",
			},
			{
				variant: "soft",
				color: "discovery",
				className:
					"bg-discovery/10 text-discovery hover:bg-discovery/20 focus-visible:border-discovery/40 focus-visible:ring-discovery/20 dark:bg-discovery/20 dark:hover:bg-discovery/30",
			},
			{
				variant: "soft",
				color: "caution",
				className:
					"bg-caution/10 text-caution hover:bg-caution/20 focus-visible:border-caution/40 focus-visible:ring-caution/20 dark:bg-caution/20 dark:hover:bg-caution/30",
			},
			// Outline variants with colors
			{
				variant: "outline",
				color: "primary",
				className:
					"border-primary/40 text-primary hover:border-primary/50 hover:bg-primary/10",
			},
			{
				variant: "outline",
				color: "secondary",
				className:
					"border-secondary/40 text-secondary hover:border-secondary/50 hover:bg-secondary/10",
			},
			{
				variant: "outline",
				color: "destructive",
				className:
					"border-destructive/40 text-destructive hover:border-destructive/50 hover:bg-destructive/10",
			},
			{
				variant: "outline",
				color: "success",
				className:
					"border-success/40 text-success hover:border-success/50 hover:bg-success/10",
			},
			{
				variant: "outline",
				color: "warning",
				className:
					"border-warning/40 text-warning hover:border-warning/50 hover:bg-warning/10",
			},
			{
				variant: "outline",
				color: "info",
				className:
					"border-info/40 text-info hover:border-info/50 hover:bg-info/10",
			},
			{
				variant: "outline",
				color: "discovery",
				className:
					"border-discovery/40 text-discovery hover:border-discovery/50 hover:bg-discovery/10",
			},
			{
				variant: "outline",
				color: "caution",
				className:
					"border-caution/40 text-caution hover:border-caution/50 hover:bg-caution/10",
			},
			// Ghost variants with colors
			{
				variant: "ghost",
				color: "primary",
				className: "text-primary hover:bg-primary/10",
			},
			{
				variant: "ghost",
				color: "secondary",
				className: "text-secondary hover:bg-secondary/10",
			},
			{
				variant: "ghost",
				color: "destructive",
				className: "text-destructive hover:bg-destructive/10",
			},
			{
				variant: "ghost",
				color: "success",
				className: "text-success hover:bg-success/10",
			},
			{
				variant: "ghost",
				color: "warning",
				className: "text-warning hover:bg-warning/10",
			},
			{
				variant: "ghost",
				color: "info",
				className: "text-info hover:bg-info/10",
			},
			{
				variant: "ghost",
				color: "discovery",
				className: "text-discovery hover:bg-discovery/10",
			},
			{
				variant: "ghost",
				color: "caution",
				className: "text-caution hover:bg-caution/10",
			},
			// Link variants with colors
			{
				variant: "link",
				color: "primary",
				className: "text-primary",
			},
			{
				variant: "link",
				color: "secondary",
				className: "text-secondary",
			},
			{
				variant: "link",
				color: "destructive",
				className: "text-destructive",
			},
			{
				variant: "link",
				color: "success",
				className: "text-success",
			},
			{
				variant: "link",
				color: "warning",
				className: "text-warning",
			},
			{
				variant: "link",
				color: "info",
				className: "text-info",
			},
			{
				variant: "link",
				color: "discovery",
				className: "text-discovery",
			},
			{
				variant: "link",
				color: "caution",
				className: "text-caution",
			},
		],
		defaultVariants: {
			variant: "default",
			color: "primary",
			size: "default",
		},
	},
);

// Loading spinner component
function LoadingSpinner({ className }: { className?: string }) {
	return (
		<svg
			className={cn(
				"size-[var(--widget-control-icon-md)] animate-spin",
				className,
			)}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
			aria-hidden="true"
		>
			<circle
				className="opacity-25"
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				strokeWidth="4"
			/>
			<path
				className="opacity-75"
				fill="currentColor"
				d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
			/>
		</svg>
	);
}

export interface ButtonProps
	extends
		Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color">,
		VariantProps<typeof buttonVariants> {
	/**
	 * Show loading state with spinner
	 */
	loading?: boolean;
	/**
	 * Custom loading text (defaults to "Loading...")
	 */
	loadingText?: string;
	/**
	 * Render as a different element (for composition)
	 */
	render?: React.ReactElement;
	/**
	 * Make button full-width (100% of container)
	 */
	block?: boolean;
	/**
	 * Show selected/active state styling
	 */
	selected?: boolean;
	/**
	 * Apply fully rounded corners (pill shape)
	 * @default true (matches apps-sdk-ui default)
	 */
	pill?: boolean;
	/**
	 * Make button square (equal width and height)
	 * Useful for icon-only buttons while maintaining flexible sizing
	 */
	uniform?: boolean;
	/**
	 * Forward ref to the button element
	 */
	ref?: React.Ref<HTMLButtonElement>;
}

/**
 * Button - Base UI button primitive with apps-sdk-ui theming
 *
 * @example
 * ```tsx
 * <Button variant="default">Click me</Button>
 * <Button variant="outline" size="sm">Small outline</Button>
 * <Button color="success" variant="soft">Confirm</Button>
 * <Button color="destructive" variant="outline">Delete</Button>
 * <Button loading>Submitting...</Button>
 * <Button size="icon"><Icon /></Button>
 * <Button uniform size="sm"><Plus /></Button>
 *
 * // CTA buttons (TheFork/Booking.com style)
 * <Button size="cta" block>Make a reservation</Button>
 * <Button size="cta" block>View details <ExternalLink /></Button>
 * ```
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{
			className,
			variant = "default",
			color = "primary",
			size = "default",
			loading = false,
			loadingText = "Loading...",
			disabled,
			children,
			render,
			block,
			selected,
			pill = true,
			uniform = false,
			...props
		},
		ref,
	) => {
		return (
			<ButtonPrimitive
				ref={ref}
				data-slot="button"
				data-loading={loading || undefined}
				data-selected={selected || undefined}
				aria-busy={loading || undefined}
				aria-pressed={selected}
				className={cn(
					buttonVariants({ variant, color, size }),
					block && "w-full",
					pill && "rounded-full",
					uniform && "aspect-square p-0",
					className,
				)}
				disabled={disabled || loading}
				render={render}
				{...props}
			>
				{loading ? (
					<>
						<LoadingSpinner className="mr-2 -ml-1" />
						{loadingText}
					</>
				) : (
					children
				)}
			</ButtonPrimitive>
		);
	},
);

Button.displayName = "Button";

export { Button, buttonVariants, LoadingSpinner };
