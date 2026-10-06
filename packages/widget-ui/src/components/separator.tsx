"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "../lib/utils";

export interface SeparatorProps extends SeparatorPrimitive.Props {}

/**
 * Separator - A visual divider between content sections
 *
 * @example
 * ```tsx
 * <div className="flex items-center gap-4">
 *   <span>Left</span>
 *   <Separator orientation="vertical" />
 *   <span>Right</span>
 * </div>
 *
 * <Separator orientation="horizontal" />
 * ```
 */
function Separator({
	className,
	orientation = "horizontal",
	...props
}: SeparatorProps) {
	return (
		<SeparatorPrimitive
			data-slot="separator"
			orientation={orientation}
			className={cn(
				"shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
				className,
			)}
			{...props}
		/>
	);
}

export { Separator };
