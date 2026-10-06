import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * Radius tier
 * -----------
 * Cards are bounded surfaces, not controls, so they sit one step above the
 * control ladder: `rounded-xl` (`--radius-xl`, `calc(var(--radius) + 4px)` =
 * 12px) rather than Kumo `LayerCard`'s shipped `rounded-lg` (8px). The
 * adapter's class wins because `LayerCard` merges its own classes through
 * tailwind-merge with `className` last. Controls *inside* a card stay on
 * `--radius` (8px) — the two tiers are what makes a card read as a layer above
 * the buttons, inputs and selects it contains. See `docs/product/design.md`
 * ("Radii"). Do not move this by bumping `--radius`: that is the control token
 * and would drag the whole ladder with it.
 */
function Card({
	className,
	size = "default",
	tone = "base",
	...props
}: ComponentProps<typeof LayerCard> & {
	size?: "default" | "sm";
	tone?: "raised" | "base";
}) {
	return (
		<LayerCard
			data-size={size}
			data-slot="card"
			data-tone={tone}
			className={cn(
				"group/card flex min-w-0 flex-col gap-4 rounded-xl border border-kumo-line py-4 type-tedix-body shadow-none! ring-0 data-[tone=raised]:bg-kumo-elevated data-[tone=raised]:shadow-tedix-raised! data-[size=sm]:gap-3 data-[size=sm]:py-3",
				className,
			)}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				"group/card-header @container/card-header grid min-w-0 auto-rows-min grid-cols-1 items-start gap-2 px-4 sm:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] sm:has-data-[slot=card-description]:grid-rows-[auto_auto] group-data-[size=sm]/card:px-3",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: ComponentProps<"h2">) {
	return (
		<h2
			data-slot="card-title"
			className={cn("font-medium text-kumo-strong type-tedix-body", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("text-kumo-subtle type-tedix-body", className)}
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn(
				"col-start-1 row-start-auto flex max-w-full flex-wrap self-start justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end",
				className,
			)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("min-w-0 px-4 group-data-[size=sm]/card:px-3", className)}
			{...props}
		/>
	);
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn(
				"flex flex-wrap items-center gap-2 px-4 group-data-[size=sm]/card:px-3",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
