import { Badge } from "@/components/kumo/badge";
import { OS_COPY } from "@/shared/os-copy";

/** True in the fixture OS and in `bun run-local --demo`; false in every deployed build. */
export const isSampleData = (): boolean =>
	typeof __SAMPLE_DATA__ !== "undefined" && __SAMPLE_DATA__;

/** Marks the shell while the data is the fictional sample company with sending off. */
export function SampleDataBadge({ show = isSampleData() }: { show?: boolean }) {
	if (!show) return null;
	return (
		<Badge
			variant="warning"
			title={OS_COPY.sampleData.description}
			data-testid="sample-data-badge"
		>
			{OS_COPY.sampleData.label}
		</Badge>
	);
}
