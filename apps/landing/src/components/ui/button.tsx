"use client";
import {
	Button as KumoButton,
	buttonVariants as kumoButtonVariants,
} from "@cloudflare/kumo/components/button";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant =
	| "default"
	| "outline"
	| "secondary"
	| "ghost"
	| "destructive"
	| "link";
type ButtonSize = "default" | "xs" | "sm" | "lg";
const VARIANT_MAP = {
	default: "primary",
	outline: "outline",
	secondary: "secondary",
	ghost: "ghost",
	destructive: "destructive",
	link: "ghost",
} as const;
const SIZE_MAP = { default: "base", xs: "xs", sm: "sm", lg: "lg" } as const;
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	loading?: boolean;
	size?: ButtonSize;
	variant?: ButtonVariant;
}
function buttonVariants({
	className,
	size = "default",
	variant = "default",
}: { className?: string; size?: ButtonSize; variant?: ButtonVariant } = {}) {
	return cn(
		kumoButtonVariants({
			shape: "base",
			size: SIZE_MAP[size],
			variant: VARIANT_MAP[variant],
		}),
		"max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 motion-reduce:transition-none",
		variant === "link" &&
			"bg-transparent text-kumo-link underline-offset-4 shadow-none hover:underline",
		className,
	);
}
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		children,
		className,
		loading,
		size = "default",
		variant = "default",
		...props
	},
	ref,
) {
	return (
		<KumoButton
			{...props}
			ref={ref}
			className={className}
			data-slot="button"
			loading={loading}
			shape="base"
			size={SIZE_MAP[size]}
			variant={VARIANT_MAP[variant]}
		>
			{children}
		</KumoButton>
	);
});
export { Button, type ButtonProps, buttonVariants };
