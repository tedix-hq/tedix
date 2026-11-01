"use client";
import {
	Button as KumoButton,
	LinkButton as KumoLinkButton,
	buttonVariants as kumoButtonVariants,
} from "@cloudflare/kumo/components/button";
import {
	forwardRef,
	type AnchorHTMLAttributes,
	type ButtonHTMLAttributes,
} from "react";
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
interface BaseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	loading?: boolean;
	size?: ButtonSize;
	variant?: ButtonVariant;
}
type ButtonShape = "base" | "square" | "circle";
type ButtonProps = BaseButtonProps &
	({ shape?: "base" } | { shape: "square" | "circle"; "aria-label": string });
function buttonVariants({
	className,
	shape = "base",
	size = "default",
	variant = "default",
}: {
	className?: string;
	shape?: ButtonShape;
	size?: ButtonSize;
	variant?: ButtonVariant;
} = {}) {
	return cn(
		kumoButtonVariants({
			shape,
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
		shape = "base",
		size = "default",
		variant = "default",
		...props
	},
	ref,
) {
	const shared = {
		...props,
		ref,
		className: cn(
			"max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 motion-reduce:transition-none",
			className,
		),
		"data-slot": "button",
		loading,
		size: SIZE_MAP[size],
		variant: VARIANT_MAP[variant],
	};
	if (shape !== "base") {
		return (
			<KumoButton {...shared} shape={shape} aria-label={props["aria-label"]!}>
				{children}
			</KumoButton>
		);
	}
	return (
		<KumoButton {...shared} shape="base">
			{children}
		</KumoButton>
	);
});
type LinkButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
	size?: ButtonSize;
	variant?: ButtonVariant;
	shape?: ButtonShape;
};
const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
	function LinkButton(
		{
			size = "default",
			variant = "default",
			shape = "base",
			className,
			...props
		},
		ref,
	) {
		return (
			<KumoLinkButton
				{...props}
				ref={ref}
				shape={shape}
				size={SIZE_MAP[size]}
				variant={VARIANT_MAP[variant]}
				className={cn(
					"max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 motion-reduce:transition-none",
					className,
				)}
			/>
		);
	},
);
export { Button, LinkButton, type ButtonProps, buttonVariants };
