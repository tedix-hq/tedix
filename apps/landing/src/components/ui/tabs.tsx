"use client";

import {
	Tabs as KumoTabsPrimitive,
	type TabsProps as KumoTabsProps,
} from "@cloudflare/kumo/components/tabs";
import { cn } from "@/lib/utils";

// Kumo does not forward an accessible name to its tablist; the labelled group
// carries it. The wrapper also owns the 44px touch target on small and coarse
// pointers, matching the Button adapter's mobile sizing.
function Tabs({
	"aria-label": ariaLabel,
	className,
	...props
}: KumoTabsProps & { "aria-label": string }) {
	return (
		<div
			role="group"
			aria-label={ariaLabel}
			className={cn(
				"max-sm:[&_[role=tablist]]:!h-auto max-sm:[&_[role=tab]]:!h-11 max-sm:[&_[role=tab]]:min-w-11 max-sm:[&_[role=tab]]:px-3 max-sm:[&_[data-kumo-part=overflow-control]]:min-h-11 max-sm:[&_[data-kumo-part=overflow-control]]:min-w-11 pointer-coarse:[&_[role=tablist]]:!h-auto pointer-coarse:[&_[role=tab]]:!h-11 pointer-coarse:[&_[role=tab]]:min-w-11 pointer-coarse:[&_[role=tab]]:px-3 pointer-coarse:[&_[data-kumo-part=overflow-control]]:min-h-11 pointer-coarse:[&_[data-kumo-part=overflow-control]]:min-w-11",
				className,
			)}
		>
			<KumoTabsPrimitive {...props} />
		</div>
	);
}

export { Tabs };
