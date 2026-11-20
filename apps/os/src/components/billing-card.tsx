import { useId, type ReactNode } from "react";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { cn } from "@/lib/utils";

export function BillingCard({
	title,
	description,
	actions,
	children,
	bodyClassName,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
	children: ReactNode;
	bodyClassName?: string;
}) {
	const titleId = useId();
	return (
		<Surface render={<section aria-labelledby={titleId} />} variant="raised">
			<header className="grid gap-3 rounded-t-lg border-b border-kumo-hairline bg-kumo-tint p-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id={titleId} className="text-base font-medium text-kumo-subtle">
						{title}
					</h2>
					{actions}
				</div>
				{description && <Text tone="secondary">{description}</Text>}
			</header>
			<div className={cn("min-w-0 p-4", bodyClassName)}>{children}</div>
		</Surface>
	);
}

export function BillingCardSkeleton({ label }: { label: string }) {
	return (
		<div className="grid gap-3 py-2" role="status" aria-label={label}>
			<Skeleton className="h-6 w-1/3" />
			<Skeleton className="h-4 w-2/3" />
			<Skeleton className="h-4 w-1/2" />
		</div>
	);
}
