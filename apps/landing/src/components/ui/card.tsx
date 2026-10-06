import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
function Card({
	className,
	size = "default",
	...props
}: ComponentProps<typeof LayerCard> & { size?: "default" | "sm" }) {
	return (
		<LayerCard
			data-size={size}
			data-slot="card"
			className={cn(
				"group/card flex min-w-0 flex-col gap-4 rounded-xl border border-kumo-line py-4 shadow-none! ring-0 data-[size=sm]:gap-3 data-[size=sm]:py-3",
				className,
			)}
			{...props}
		/>
	);
}
function CardHeader({ className, ...props }: ComponentProps<"div">) {
	return (
		<div data-slot="card-header" className={cn("px-4", className)} {...props} />
	);
}
function CardTitle({ className, ...props }: ComponentProps<"h2">) {
	return (
		<h2
			data-slot="card-title"
			className={cn("font-medium", className)}
			{...props}
		/>
	);
}
function CardDescription({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("text-kumo-subtle", className)}
			{...props}
		/>
	);
}
function CardContent({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("min-w-0 px-4", className)}
			{...props}
		/>
	);
}
function CardFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn("flex items-center px-4", className)}
			{...props}
		/>
	);
}
export {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
