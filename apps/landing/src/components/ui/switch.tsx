"use client";
import { Switch as SwitchPrimitive } from "@cloudflare/kumo/primitives/switch";
import { cn } from "@/lib/utils";
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn("motion-reduce:transition-none", className)}
			{...props}
		/>
	);
}
function SwitchThumb({ className, ...props }: SwitchPrimitive.Thumb.Props) {
	return (
		<SwitchPrimitive.Thumb
			data-slot="switch-thumb"
			className={cn("motion-reduce:transition-none", className)}
			{...props}
		/>
	);
}
export { Switch, SwitchThumb };
