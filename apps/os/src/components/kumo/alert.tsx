import { Banner } from "@cloudflare/kumo/components/banner";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

type AlertVariant = "default" | "destructive" | "info" | "warning";

const ALERT_VARIANTS = {
	default: "secondary",
	destructive: "error",
	info: "default",
	warning: "alert",
} as const;

type AlertProps = Omit<
	ComponentProps<typeof Banner>,
	"description" | "title" | "variant"
> & {
	action?: ReactNode;
	description?: ReactNode;
	icon?: ReactNode;
	title?: string;
	variant?: AlertVariant;
};

/** Kumo Banner behavior with Tedix's existing compositional alert anatomy. */
function Alert({
	children,
	className,
	variant = "default",
	...props
}: AlertProps) {
	return (
		<Banner
			data-slot="alert"
			data-variant={variant}
			role={variant === "destructive" ? "alert" : undefined}
			variant={ALERT_VARIANTS[variant]}
			className={cn(
				"group/alert relative grid w-full gap-0.5 text-left has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 has-data-[slot=alert-action]:pr-18 *:[svg:not([class*='size-'])]:size-4 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
				variant === "destructive" && "text-kumo-danger",
				className,
			)}
			{...props}
		>
			{/* Keep compositional title/description slots out of Banner's paragraph fallback. */}
			<>{children}</>
		</Banner>
	);
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-title"
			className={cn(
				"font-medium type-tedix-control group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-kumo-strong",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(
				"text-balance text-kumo-subtle type-tedix-body group-data-[variant=destructive]/alert:text-kumo-danger [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-kumo-strong [&_p:not(:last-child)]:mb-4",
				className,
			)}
			{...props}
		/>
	);
}

function AlertAction({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-action"
			className={cn("absolute top-0 right-0", className)}
			{...props}
		/>
	);
}

export { Alert, AlertAction, AlertDescription, type AlertProps, AlertTitle };
