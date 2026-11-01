"use client";
import { Toggle as TogglePrimitive } from "@cloudflare/kumo/primitives/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@cloudflare/kumo/primitives/toggle-group";
import { cn } from "@/lib/utils";
function ToggleGroup<Value extends string>({
	className,
	...props
}: ToggleGroupPrimitive.Props<Value>) {
	return (
		<ToggleGroupPrimitive
			data-slot="toggle-group"
			className={cn("inline-flex items-center", className)}
			{...props}
		/>
	);
}
function Toggle<Value extends string>({
	className,
	...props
}: TogglePrimitive.Props<Value>) {
	return (
		<TogglePrimitive
			data-slot="toggle"
			className={cn("motion-reduce:transition-none", className)}
			{...props}
		/>
	);
}
export { Toggle, ToggleGroup };
