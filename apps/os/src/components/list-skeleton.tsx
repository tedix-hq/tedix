import { Skeleton } from "@/components/kumo/skeleton";

/**
 * The one loading recipe for list surfaces: grey blocks in the geometry of the
 * rows they replace. `rowClassName` sets the row height (defaults to the
 * standard 56px list row).
 */
export function ListSkeleton({
	rows = 3,
	rowClassName = "h-14",
}: {
	rows?: number;
	rowClassName?: string;
}) {
	return (
		<div className="grid gap-2" aria-hidden>
			{Array.from({ length: rows }, (_, index) => (
				<Skeleton key={index} className={rowClassName} />
			))}
		</div>
	);
}
