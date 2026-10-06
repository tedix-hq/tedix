import {
	type BadgeVariant as KumoBadgeVariant,
	KUMO_BADGE_BASE_STYLES,
} from "@cloudflare/kumo/components/badge";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type BadgeVariant =
	| "default"
	| "secondary"
	| "destructive"
	| "success"
	| "outline"
	| KumoBadgeVariant;
const VARIANT_MAP = {
	default: "primary",
	secondary: "secondary",
	destructive: "error",
	success: "success",
	outline: "outline",
} as const;
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
interface BadgeProps extends ComponentProps<"span"> {
	variant?: BadgeVariant;
}
function badgeVariants({
	className,
	variant = "default",
}: { className?: string; variant?: BadgeVariant } = {}) {
	const kumoVariant =
		VARIANT_MAP[variant as keyof typeof VARIANT_MAP] ?? variant;
	return cn(
		KUMO_BADGE_BASE_STYLES,
		"type-tedix-label",
		VARIANT_CLASSES[kumoVariant],
		className,
	);
}
function Badge({ className, variant = "default", ...props }: BadgeProps) {
	return (
		<span
			data-slot="badge"
			className={badgeVariants({ className, variant })}
			{...props}
		/>
	);
}
export { Badge, type BadgeProps, type BadgeVariant, badgeVariants };
