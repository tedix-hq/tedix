import { useOsFormattingPreferences } from "@/lib/format";
import type { MetricBucket, MetricRange } from "@/lib/skill-run-metrics";
import { osLocale, osTimeZone } from "@/lib/format";

function bucketLabel(start: string, range: MetricRange): string {
	const timeZone = osTimeZone();
	return new Date(start).toLocaleString(
		osLocale(),
		range === "24h"
			? { hour: "numeric", ...(timeZone ? { timeZone } : {}) }
			: { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) },
	);
}

/**
 * Finished runs per hour or per day, completed under failed. Drawn with
 * plain boxes so it follows the theme; the figures are also in the
 * accessible name of each bar.
 */
export function SkillRunChart({
	buckets,
	range,
}: {
	buckets: readonly MetricBucket[];
	range: MetricRange;
}) {
	useOsFormattingPreferences();
	const peak = Math.max(1, ...buckets.map((b) => b.completed + b.failed));
	const total = buckets.reduce((n, b) => n + b.completed + b.failed, 0);
	if (total === 0)
		return (
			<p className="m-0 text-kumo-subtle type-tedix-control">
				No finished runs in this time.
			</p>
		);
	const first = buckets[0];
	const last = buckets[buckets.length - 1];
	return (
		<figure
			className="m-0 grid min-w-0 gap-2"
			aria-label="Finished runs over time"
		>
			<div
				role="list"
				className="flex h-32 min-w-0 items-end gap-px border-kumo-line border-b"
			>
				{buckets.map((bucket) => {
					const count = bucket.completed + bucket.failed;
					return (
						<div
							key={bucket.start}
							role="listitem"
							aria-label={`${bucketLabel(bucket.start, range)}: ${bucket.completed} completed, ${bucket.failed} failed`}
							title={`${bucketLabel(bucket.start, range)}: ${bucket.completed} completed, ${bucket.failed} failed`}
							className="flex h-full min-w-0 flex-1 flex-col justify-end"
						>
							{bucket.failed > 0 ? (
								<div
									className="w-full bg-kumo-danger"
									style={{ height: `${(bucket.failed / peak) * 100}%` }}
								/>
							) : null}
							{bucket.completed > 0 ? (
								<div
									className="w-full bg-kumo-success"
									style={{ height: `${(bucket.completed / peak) * 100}%` }}
								/>
							) : count === 0 ? (
								<div className="h-px w-full bg-kumo-line" />
							) : null}
						</div>
					);
				})}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-kumo-subtle type-tedix-control">
				<span>
					{first ? bucketLabel(first.start, range) : ""} –{" "}
					{last ? bucketLabel(last.start, range) : ""}
				</span>
				<span className="inline-flex items-center gap-3">
					<span className="inline-flex items-center gap-1">
						<span className="size-2 bg-kumo-success" aria-hidden /> Completed
					</span>
					<span className="inline-flex items-center gap-1">
						<span className="size-2 bg-kumo-danger" aria-hidden /> Failed
					</span>
				</span>
			</div>
		</figure>
	);
}
