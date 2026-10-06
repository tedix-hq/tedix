"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

// =============================================================================
// VARIANTS
// =============================================================================

export const emptyMessageVariants = cva(
	"flex flex-col items-center justify-center text-center",
	{
		variants: {
			fill: {
				// apps-sdk-ui compatible values
				static: "h-full w-full",
				absolute: "absolute inset-0",
				none: "",
				viewport: "min-h-screen",
			},
		},
		defaultVariants: {
			fill: "static",
		},
	},
);

/**
 * Icon badge variants - apps-sdk-ui compatible
 * Uses badge-style design with background colors
 */
export const iconBadgeVariants = cva(
	"mb-3 flex items-center justify-center rounded-md",
	{
		variants: {
			size: {
				sm: "h-8 w-8 [&>svg]:h-5 [&>svg]:w-5",
				md: "h-10 w-10 [&>svg]:h-6 [&>svg]:w-6",
				lg: "h-12 w-12 [&>svg]:h-8 [&>svg]:w-8",
			},
			color: {
				// apps-sdk-ui compatible colors
				secondary: "bg-muted text-muted-foreground",
				danger: "bg-destructive/10 text-destructive",
				warning:
					"bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-500",
				primary: "bg-primary/10 text-primary",
			},
		},
		defaultVariants: {
			size: "md",
			color: "secondary",
		},
	},
);

export const titleVariants = cva(
	"max-w-[90%] text-balance text-center font-semibold",
	{
		variants: {
			size: {
				sm: "text-base",
				md: "text-base",
				lg: "text-lg",
			},
			color: {
				// apps-sdk-ui compatible colors
				secondary: "text-foreground",
				danger: "text-destructive",
				warning: "text-amber-600 dark:text-amber-500",
			},
		},
		defaultVariants: {
			size: "md",
			color: "secondary",
		},
	},
);

export const descriptionVariants = cva(
	"mt-1.5 max-w-[90%] text-balance text-center text-muted-foreground text-sm leading-relaxed",
	{
		variants: {
			size: {
				sm: "text-xs",
				md: "text-sm",
				lg: "text-base",
			},
		},
		defaultVariants: {
			size: "md",
		},
	},
);

// =============================================================================
// TYPES
// =============================================================================

/** Fill options - apps-sdk-ui compatible + widget-ui extended */
export type EmptyMessageFill = "static" | "absolute" | "none" | "viewport";

/** Icon colors - apps-sdk-ui compatible + widget-ui extended */
export type EmptyMessageIconColor =
	| "secondary"
	| "danger"
	| "warning" // apps-sdk-ui
	| "primary";

/** Title colors - apps-sdk-ui compatible */
export type EmptyMessageTitleColor = "secondary" | "danger" | "warning";

export interface EmptyMessageProps
	extends
		React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof emptyMessageVariants> {
	/**
	 * How the empty message should fill its container
	 * - `static`: Fills parent width/height (apps-sdk-ui default)
	 * - `absolute`: Absolutely positioned to fill container
	 * - `none`: No fill behavior
	 * - `viewport`: Fills viewport height
	 * @default "static"
	 */
	fill?: EmptyMessageFill;
}

export interface EmptyMessageIconProps
	extends
		Omit<React.HTMLAttributes<HTMLDivElement>, "color">,
		VariantProps<typeof iconBadgeVariants> {
	/**
	 * Icon size
	 * @default "md"
	 */
	size?: "sm" | "md" | "lg";
	/**
	 * Icon badge color
	 * - `secondary`: Muted background (apps-sdk-ui default)
	 * - `danger`: Destructive/error state
	 * - `warning`: Warning state
	 * - `primary`: Primary brand color
	 * @default "secondary"
	 */
	color?: EmptyMessageIconColor;
}

export interface EmptyMessageTitleProps
	extends
		React.HTMLAttributes<HTMLHeadingElement>,
		VariantProps<typeof titleVariants> {
	/**
	 * Title size
	 * @default "md"
	 */
	size?: "sm" | "md" | "lg";
	/**
	 * Title color for semantic states
	 * - `secondary`: Default foreground (apps-sdk-ui default)
	 * - `danger`: Destructive/error state
	 * - `warning`: Warning state
	 * @default "secondary"
	 */
	color?: EmptyMessageTitleColor;
}

export interface EmptyMessageDescriptionProps
	extends
		React.HTMLAttributes<HTMLParagraphElement>,
		VariantProps<typeof descriptionVariants> {
	/**
	 * Description size
	 * @default "md"
	 */
	size?: "sm" | "md" | "lg";
}

export interface EmptyMessageActionRowProps extends React.HTMLAttributes<HTMLDivElement> {}

// =============================================================================
// COMPOUND COMPONENTS
// =============================================================================

/**
 * Icon component with badge-style design (apps-sdk-ui compatible)
 */
function EmptyMessageIcon({
	className,
	size = "md",
	color = "secondary",
	children,
	...props
}: EmptyMessageIconProps) {
	return (
		<div
			data-slot="empty-message-icon"
			data-size={size}
			data-color={color}
			className={cn(iconBadgeVariants({ size, color }), className)}
			aria-hidden="true"
			{...props}
		>
			{children}
		</div>
	);
}

/**
 * Title component with semantic color support (apps-sdk-ui compatible)
 */
function EmptyMessageTitle({
	className,
	size = "md",
	color = "secondary",
	children,
	...props
}: EmptyMessageTitleProps) {
	return (
		<div
			data-slot="empty-message-title"
			data-color={color}
			className={cn(titleVariants({ size, color }), className)}
			{...props}
		>
			{children}
		</div>
	);
}

/**
 * Description component for secondary text
 */
function EmptyMessageDescription({
	className,
	size = "md",
	children,
	...props
}: EmptyMessageDescriptionProps) {
	return (
		<div
			data-slot="empty-message-description"
			className={cn(descriptionVariants({ size }), className)}
			{...props}
		>
			{children}
		</div>
	);
}

/**
 * Action row for buttons and links
 */
function EmptyMessageActionRow({
	className,
	children,
	...props
}: EmptyMessageActionRowProps) {
	return (
		<div
			data-slot="empty-message-action-row"
			className={cn(
				"mt-4 flex flex-wrap items-center justify-center gap-2",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * EmptyMessage - Layer 2 Composite (apps-sdk-ui compatible)
 *
 * A reusable empty state component with icon, title, description, and optional action.
 * Uses compound components for explicit, composable customization.
 *
 * @example apps-sdk-ui style (recommended):
 * ```tsx
 * <EmptyMessage>
 *   <EmptyMessage.Icon>
 *     <ExploreIcon />
 *   </EmptyMessage.Icon>
 *   <EmptyMessage.Title>Your evaluations will appear here</EmptyMessage.Title>
 *   <EmptyMessage.Description>
 *     Create an evaluation to assess your model's responses
 *   </EmptyMessage.Description>
 *   <EmptyMessage.ActionRow>
 *     <Button color="primary" onClick={handleCreate}>Create</Button>
 *   </EmptyMessage.ActionRow>
 * </EmptyMessage>
 * ```
 *
 * @example Error state:
 * ```tsx
 * <EmptyMessage>
 *   <EmptyMessage.Icon color="danger">
 *     <MicIcon />
 *   </EmptyMessage.Icon>
 *   <EmptyMessage.Title color="danger">
 *     Enable microphone access in your browser's settings.
 *   </EmptyMessage.Title>
 * </EmptyMessage>
 * ```
 *
 */
function EmptyMessageRoot({
	fill = "static",
	className,
	children,
	...props
}: EmptyMessageProps) {
	return (
		<div
			data-slot="empty-message"
			data-fill={fill}
			className={cn(emptyMessageVariants({ fill }), className)}
			{...props}
		>
			{children}
		</div>
	);
}

// Attach compound components
const EmptyMessage = Object.assign(EmptyMessageRoot, {
	Icon: EmptyMessageIcon,
	Title: EmptyMessageTitle,
	Description: EmptyMessageDescription,
	ActionRow: EmptyMessageActionRow,
});

export { EmptyMessage };
