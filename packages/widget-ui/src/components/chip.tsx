"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";

const chipVariants = cva(
	"inline-flex items-center justify-center rounded-full border font-medium transition-colors",
	{
		variants: {
			variant: {
				default: "border-transparent bg-primary text-primary-foreground",
				secondary: "border-transparent bg-secondary text-secondary-foreground",
				destructive: "border-transparent bg-destructive/10 text-destructive",
				outline: "border-border bg-background text-foreground",
				success: "border-transparent bg-success/10 text-success",
				warning: "border-transparent bg-warning/10 text-warning",
				filled: "border-transparent bg-muted text-muted-foreground",
				discovery: "border-transparent bg-discovery/10 text-discovery",
				info: "border-transparent bg-info/10 text-info",
				caution: "border-transparent bg-caution/10 text-caution",
			},
			size: {
				sm: "h-5 px-2 text-xs",
				md: "h-6 px-2.5 text-sm",
				lg: "h-7 px-3 text-sm",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "md",
		},
	},
);

export interface ChipProps
	extends useRender.ComponentProps<"span">, VariantProps<typeof chipVariants> {
	/**
	 * Shows a dismiss/close button when true
	 */
	dismissible?: boolean;
	/**
	 * Callback when dismiss button is clicked
	 */
	onDismiss?: () => void;
	/**
	 * Makes the chip interactive with hover/focus/active states.
	 * When true, renders as button. Can be overridden with render prop.
	 */
	interactive?: boolean;
	/**
	 * Icon to show on the left side
	 */
	leftIcon?: React.ReactNode;
	/**
	 * Icon to show on the right side
	 */
	rightIcon?: React.ReactNode;
	/**
	 * Selected state styling
	 */
	selected?: boolean;
	/**
	 * Disabled state styling
	 */
	disabled?: boolean;
}

/**
 * Chip - Rounded badge/tag component for labels and status indicators
 *
 * Uses useRender pattern for flexible rendering (can be span, a, button, etc.)
 *
 * @example
 * ```tsx
 * <Chip>Default</Chip>
 * <Chip variant="success" size="sm">Active</Chip>
 * <Chip variant="warning">Pending</Chip>
 * <Chip dismissible onDismiss={() => handleRemove()}>Removable</Chip>
 * <Chip interactive onClick={() => console.log('clicked')}>Clickable</Chip>
 * <Chip leftIcon={<Check />} selected>Selected</Chip>
 * <Chip rightIcon={<Star />} disabled>Disabled</Chip>
 * <Chip render={<a href="/filter" />}>Link Chip</Chip>
 * ```
 */
function Chip({
	className,
	variant,
	size,
	dismissible,
	onDismiss,
	interactive,
	leftIcon,
	rightIcon,
	selected,
	disabled,
	children,
	render,
	...props
}: ChipProps) {
	const handleDismissClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		onDismiss?.();
	};

	const interactiveClasses =
		interactive && !disabled
			? "cursor-pointer hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:brightness-110"
			: "";

	const selectedClasses = selected
		? "ring-2 ring-ring ring-offset-2 ring-offset-background"
		: "";

	const disabledClasses = disabled
		? "opacity-50 cursor-not-allowed pointer-events-none"
		: "";

	const content = (
		<>
			{leftIcon && (
				<span className="mr-1 inline-flex shrink-0">{leftIcon}</span>
			)}
			{children}
			{rightIcon && !dismissible && (
				<span className="ml-1 inline-flex shrink-0">{rightIcon}</span>
			)}
			{dismissible && (
				<button
					type="button"
					onClick={handleDismissClick}
					disabled={disabled}
					className="ml-1 opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
					aria-label="Dismiss"
				>
					<X className="h-3 w-3" />
				</button>
			)}
		</>
	);

	// Determine default tag based on interactive state
	const defaultTagName = interactive && !disabled ? "button" : "span";

	return useRender({
		defaultTagName,
		props: mergeProps<typeof defaultTagName>(
			{
				"data-slot": "chip",
				"data-selected": selected ? "" : undefined,
				"data-disabled": disabled ? "" : undefined,
				"data-interactive": interactive ? "" : undefined,
				...(defaultTagName === "button" && { type: "button", disabled }),
				className: cn(
					chipVariants({ variant, size }),
					interactiveClasses,
					selectedClasses,
					disabledClasses,
					className,
				),
				children: content,
			} as React.ComponentProps<typeof defaultTagName>,
			props as React.ComponentProps<typeof defaultTagName>,
		),
		render,
		state: {
			slot: "chip",
			variant,
			size,
			selected,
			disabled,
			interactive,
		},
	});
}

export { Chip, chipVariants };
