import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Kumo has no keyboard-key component; keep this Tedix semantic composite. */
function Kbd({ className, ...props }: ComponentProps<"kbd">) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-kumo-fill px-1 font-medium font-sans text-kumo-subtle type-tedix-caption [&_svg:not([class*='size-'])]:size-3",
				className,
			)}
			{...props}
		/>
	);
}

export { Kbd };
