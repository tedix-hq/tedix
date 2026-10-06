import { Label as KumoLabel } from "@cloudflare/kumo/components/label";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type LabelProps = ComponentProps<typeof KumoLabel>;

function Label({ className, ...props }: LabelProps) {
	return (
		<KumoLabel
			data-slot="label"
			className={cn(
				"select-none type-tedix-body peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Label, type LabelProps };
