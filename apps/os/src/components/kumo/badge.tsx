import {
	type BadgeVariant as KumoBadgeVariant,
	KUMO_BADGE_BASE_STYLES,
} from "@cloudflare/kumo/components/badge";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type BadgeVariant =
	| "default"
	| "secondary"
	| "destructive"
	| "success"
	| "outline"
	| "ghost"
	| "link"
	| KumoBadgeVariant;
type BadgeAppearance = "filled" | "dot";

const VARIANT_MAP = {
	default: "primary",
	secondary: "secondary",
	destructive: "error",
	success: "success",
	outline: "outline",
	ghost: "secondary",
	link: "primary",
} as const satisfies Partial<Record<BadgeVariant, KumoBadgeVariant>>;

const VARIANT_CLASSES: Record<KumoBadgeVariant, string> = {
	primary: "bg-kumo-badge-inverted text-kumo-badge-inverted",
	secondary: "bg-kumo-fill text-kumo-badge-neutral-subtle",
	error: "bg-kumo-danger-tint text-kumo-danger",
	warning: "bg-kumo-warning-tint text-kumo-warning",
	success: "bg-kumo-success-tint text-kumo-success",
	destructive: "bg-kumo-badge-red text-white",
	info: "bg-kumo-info-tint text-kumo-info",
	beta: "border border-dashed border-kumo-brand bg-transparent text-kumo-link",
	outline: "border border-kumo-fill bg-transparent text-kumo-default",
	red: "bg-kumo-badge-red text-white",
	green: "bg-kumo-badge-green text-white",
	neutral: "bg-kumo-badge-neutral text-white",
	orange: "bg-kumo-badge-orange text-black",
	purple: "bg-kumo-badge-purple text-white",
	teal: "bg-kumo-badge-teal text-white",
	"teal-subtle": "bg-kumo-badge-teal-subtle text-kumo-badge-teal-subtle",
	blue: "bg-kumo-badge-blue text-white",
};

const DOT_CLASSES: Partial<Record<KumoBadgeVariant, string>> = {
	success: "bg-kumo-success",
	warning: "bg-kumo-badge-orange",
	error: "bg-kumo-badge-red",
	neutral: "bg-kumo-badge-neutral",
};

interface BadgeProps extends ComponentProps<"span"> {
	appearance?: BadgeAppearance;
	variant?: BadgeVariant;
}

function badgeVariants({
	className,
	variant = "default",
	appearance = "filled",
}: {
	className?: string;
	variant?: BadgeVariant;
	appearance?: BadgeAppearance;
} = {}) {
	const kumoVariant =
		VARIANT_MAP[variant as keyof typeof VARIANT_MAP] ?? variant;

	return cn(
		KUMO_BADGE_BASE_STYLES,
		"type-tedix-label",
		appearance === "filled" && VARIANT_CLASSES[kumoVariant],
		appearance === "dot" &&
			"gap-1.5 bg-transparent text-kumo-default ring ring-kumo-hairline",
		variant === "ghost" && "bg-transparent",
		variant === "link" && "bg-transparent text-kumo-link hover:underline",
		className,
	);
}

function Badge({
	children,
	className,
	variant = "default",
	appearance = "filled",
	...props
}: BadgeProps) {
	const kumoVariant =
		VARIANT_MAP[variant as keyof typeof VARIANT_MAP] ?? variant;
	const dotClassName =
		appearance === "dot" ? DOT_CLASSES[kumoVariant] : undefined;

	return (
		<span
			data-slot="badge"
			className={badgeVariants({ className, variant, appearance })}
			{...props}
		>
			{dotClassName && (
				<span
					aria-hidden="true"
					className={cn("size-1.75 shrink-0 rounded-full", dotClassName)}
				/>
			)}
			{children}
		</span>
	);
}

export { Badge, type BadgeProps, type BadgeVariant, badgeVariants };
