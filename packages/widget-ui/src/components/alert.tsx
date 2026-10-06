import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	Lightbulb,
	Sparkles,
	X,
} from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

/**
 * Alert color options matching apps-sdk-ui.
 * Maps to semantic colors for the alert.
 */
export type AlertColor =
	| "primary"
	| "success"
	| "info"
	| "discovery"
	| "danger"
	| "warning"
	| "caution";

/**
 * Alert style variant options matching apps-sdk-ui.
 */
export type AlertVariant = "soft" | "solid" | "outline";

/**
 * Indicator bar colors mapped to color names.
 * Used when indicator={true} to show a colored left border.
 */
const INDICATOR_BAR_COLORS: Record<AlertColor | "default", string> = {
	primary: "bg-primary",
	info: "bg-info",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	discovery: "bg-discovery",
	caution: "bg-caution",
	default: "bg-foreground",
};

/**
 * Default indicator icons mapped to semantic colors.
 * Used when indicator is not provided (default behavior shows icon).
 */
const DEFAULT_ICONS: Record<
	AlertColor | "default",
	React.ComponentType<{ className?: string }>
> = {
	primary: Info,
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	danger: AlertCircle,
	discovery: Sparkles,
	caution: Lightbulb,
	default: Info,
};

/**
 * Base alert styles (grid layout, sizing, etc.)
 * Uses apps-sdk-ui pattern: separate color + variant props
 */
const alertBase =
	"relative grid w-full grid-cols-[0_1fr] items-center gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*5)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-5 [&>svg]:text-current";

/**
 * Color styles for each semantic color.
 * These are applied on top of the variant styles.
 */
const colorStyles: Record<
	AlertColor,
	{ soft: string; solid: string; outline: string }
> = {
	primary: {
		soft: "border-primary/50 bg-primary/10 text-primary dark:border-primary [&>svg]:text-primary",
		solid:
			"border-primary bg-primary text-primary-foreground [&>svg]:text-primary-foreground",
		outline: "border-primary bg-transparent text-primary [&>svg]:text-primary",
	},
	info: {
		soft: "border-info/50 bg-info/10 text-info dark:border-info [&>svg]:text-info",
		solid:
			"border-info bg-info text-info-foreground [&>svg]:text-info-foreground",
		outline: "border-info bg-transparent text-info [&>svg]:text-info",
	},
	success: {
		soft: "border-success/50 bg-success/10 text-success dark:border-success [&>svg]:text-success",
		solid:
			"border-success bg-success text-success-foreground [&>svg]:text-success-foreground",
		outline: "border-success bg-transparent text-success [&>svg]:text-success",
	},
	warning: {
		soft: "border-warning/50 bg-warning/10 text-warning dark:border-warning [&>svg]:text-warning",
		solid:
			"border-warning bg-warning text-warning-foreground [&>svg]:text-warning-foreground",
		outline: "border-warning bg-transparent text-warning [&>svg]:text-warning",
	},
	danger: {
		soft: "border-destructive/50 bg-destructive/10 text-destructive dark:border-destructive [&>svg]:text-destructive",
		solid:
			"border-destructive bg-destructive text-destructive-foreground [&>svg]:text-destructive-foreground",
		outline:
			"border-destructive bg-transparent text-destructive [&>svg]:text-destructive",
	},
	discovery: {
		soft: "border-discovery/50 bg-discovery/10 text-discovery dark:border-discovery [&>svg]:text-discovery",
		solid:
			"border-discovery bg-discovery text-discovery-foreground [&>svg]:text-discovery-foreground",
		outline:
			"border-discovery bg-transparent text-discovery [&>svg]:text-discovery",
	},
	caution: {
		soft: "border-caution/50 bg-caution/10 text-caution dark:border-caution [&>svg]:text-caution",
		solid:
			"border-caution bg-caution text-caution-foreground [&>svg]:text-caution-foreground",
		outline: "border-caution bg-transparent text-caution [&>svg]:text-caution",
	},
};

/**
 * Default (neutral) styles when no color is specified.
 */
const defaultStyles: Record<AlertVariant, string> = {
	soft: "bg-muted/50 border-border text-foreground",
	solid: "bg-muted border-border text-foreground",
	outline: "bg-transparent border-border text-foreground",
};

/**
 * Helper to get alert classes based on color and variant.
 */
function getAlertClasses(
	color?: AlertColor,
	variant: AlertVariant = "soft",
): string {
	if (color) {
		return colorStyles[color][variant];
	}
	return defaultStyles[variant];
}

export interface AlertProps extends Omit<
	React.HTMLAttributes<HTMLDivElement>,
	"title" | "color"
> {
	/**
	 * Semantic color for the alert (apps-sdk-ui pattern).
	 * @example color="success"
	 * @example color="warning"
	 */
	color?: AlertColor;
	/** Visual treatment for the semantic color. @default "soft" */
	variant?: AlertVariant;
	/**
	 * Action buttons to display in the alert
	 */
	actions?: React.ReactNode;
	/**
	 * Placement of action buttons
	 * - "end": Actions at the end of the alert (right side)
	 * - "bottom": Actions below the content
	 * - "auto": Automatically switches to "bottom" when actions exceed 1/3 of container width
	 * @default "end"
	 */
	actionsPlacement?: "end" | "bottom" | "auto";
	/**
	 * Additional className for the actions container
	 */
	actionsClassName?: string;
	/**
	 * Optional override for the default indicator icon.
	 * - undefined: Shows semantic icon based on color (default apps-sdk-ui behavior)
	 * - false: No indicator shown
	 * - true: Shows a colored left border bar (widget-ui enhancement)
	 * - ReactNode: Custom indicator element (e.g., custom icon)
	 *
	 * @example indicator={false} // Hide icon
	 * @example indicator={<Lightbulb />} // Custom icon
	 */
	indicator?: React.ReactNode | boolean;
	/**
	 * Title text to display in the alert (convenience prop, alternative to AlertTitle)
	 */
	title?: React.ReactNode;
	/**
	 * Optional description text to display below the alert content
	 */
	description?: React.ReactNode;
	/**
	 * Callback when dismiss button is clicked. If provided, shows a dismiss button.
	 * Note: apps-sdk-ui recommends using labeled buttons via `actions` instead.
	 */
	onDismiss?: () => void;
	/**
	 * Accessible label for the dismiss button
	 * @default "Dismiss"
	 */
	dismissLabel?: string;
}

function Alert({
	className,
	color,
	variant,
	actions,
	actionsPlacement = "end",
	actionsClassName,
	indicator,
	title,
	description,
	onDismiss,
	dismissLabel = "Dismiss",
	children,
	...props
}: AlertProps) {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const actionsRef = React.useRef<HTMLDivElement>(null);
	const [computedPlacement, setComputedPlacement] = React.useState<
		"end" | "bottom"
	>(actionsPlacement === "auto" ? "end" : actionsPlacement);

	const resolvedColor = color;
	const resolvedVariant = variant ?? "soft";

	// Auto placement: switch to bottom when actions exceed 1/3 of container width
	React.useEffect(() => {
		if (actionsPlacement !== "auto" || !actions) {
			setComputedPlacement(
				actionsPlacement === "auto" ? "end" : actionsPlacement,
			);
			return;
		}

		const container = containerRef.current;
		const actionsEl = actionsRef.current;
		if (!container || !actionsEl) return;

		const observer = new ResizeObserver(() => {
			const containerWidth = container.offsetWidth;
			const actionsWidth = actionsEl.offsetWidth;
			const threshold = containerWidth / 3;
			setComputedPlacement(actionsWidth > threshold ? "bottom" : "end");
		});

		observer.observe(container);
		observer.observe(actionsEl);

		return () => observer.disconnect();
	}, [actionsPlacement, actions]);

	const isBottom = computedPlacement === "bottom";
	const hasEndActions = (actions || onDismiss) && !isBottom;

	// Determine indicator behavior:
	// - undefined: Show default icon based on color (apps-sdk-ui default)
	// - false: No indicator
	// - true: Show colored bar (widget-ui enhancement)
	// - ReactNode: Custom indicator element
	const showColoredBar = indicator === true;
	const showDefaultIcon = indicator === undefined;
	const showCustomIndicator =
		indicator !== undefined && indicator !== true && indicator !== false;

	// Get the default icon based on color
	const DefaultIcon = showDefaultIcon
		? DEFAULT_ICONS[resolvedColor ?? "default"]
		: null;

	// Get colored bar color
	const barColor = showColoredBar
		? INDICATOR_BAR_COLORS[resolvedColor ?? "default"]
		: null;

	return (
		<div
			ref={containerRef}
			role="alert"
			data-slot="alert"
			data-color={resolvedColor}
			data-variant={resolvedVariant}
			data-has-actions={actions || onDismiss ? "" : undefined}
			data-actions-placement={
				actions || onDismiss ? computedPlacement : undefined
			}
			data-dismissible={onDismiss ? "" : undefined}
			className={cn(
				alertBase,
				getAlertClasses(resolvedColor, resolvedVariant),
				showColoredBar && "overflow-hidden pl-5",
				// Extend grid to 3 columns when actions are at the end
				hasEndActions &&
					"grid-cols-[0_1fr_auto] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr_auto]",
				className,
			)}
			{...props}
		>
			{showColoredBar && barColor && (
				<div
					className={cn("absolute inset-y-0 left-0 w-1", barColor)}
					data-slot="alert-indicator-bar"
				/>
			)}
			{DefaultIcon && <DefaultIcon className="size-5" />}
			{showCustomIndicator && indicator}
			{title && <AlertTitle>{title}</AlertTitle>}
			{children}
			{description && <AlertDescription>{description}</AlertDescription>}
			{(actions || onDismiss) && (
				<div
					ref={actionsRef}
					data-slot="alert-actions"
					className={cn(
						"flex shrink-0 items-center gap-2",
						isBottom
							? "col-span-full mt-2"
							: "col-start-3 row-span-full self-center",
						actionsClassName,
					)}
				>
					{actions}
					{onDismiss && (
						<button
							type="button"
							onClick={onDismiss}
							className={cn(
								"inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity",
								"hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
								"disabled:pointer-events-none",
							)}
							aria-label={dismissLabel}
						>
							<X className="size-4" />
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function AlertTitle({
	className,
	...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h5
			data-slot="alert-title"
			className={cn(
				"col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDescription({
	className,
	...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
	return (
		<div
			data-slot="alert-description"
			className={cn("col-start-2 text-sm [&_p]:leading-relaxed", className)}
			{...props}
		/>
	);
}

export { Alert, AlertTitle, AlertDescription };
