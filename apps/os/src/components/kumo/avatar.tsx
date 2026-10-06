import { Avatar as AvatarPrimitive } from "@cloudflare/kumo/primitives/avatar";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

function Avatar({
	className,
	size = "default",
	...props
}: AvatarPrimitive.Root.Props & { size?: "default" | "sm" | "lg" }) {
	return (
		<AvatarPrimitive.Root
			data-slot="avatar"
			data-size={size}
			className={cn(
				"group/avatar relative flex size-8 shrink-0 select-none rounded-full ring ring-kumo-line data-[size=lg]:size-10 data-[size=sm]:size-6",
				className,
			)}
			{...props}
		/>
	);
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
	return (
		<AvatarPrimitive.Image
			data-slot="avatar-image"
			className={cn(
				"aspect-square size-full rounded-[inherit] object-cover",
				className,
			)}
			{...props}
		/>
	);
}

function AvatarFallback({
	className,
	...props
}: AvatarPrimitive.Fallback.Props) {
	return (
		<AvatarPrimitive.Fallback
			data-slot="avatar-fallback"
			className={cn(
				"flex size-full items-center justify-center rounded-[inherit] bg-kumo-fill text-kumo-subtle type-tedix-control group-data-[size=sm]/avatar:type-tedix-label",
				className,
			)}
			{...props}
		/>
	);
}

export { Avatar, AvatarFallback, AvatarImage };
