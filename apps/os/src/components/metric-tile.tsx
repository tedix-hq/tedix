import {
	MetricTileSchema,
	type MetricTile as MetricTileData,
} from "@tedix/api-contract/schemas/metric-tile";
import { Link } from "@/components/kumo/link";
import {
	MetricItem,
	type MetricItemProps,
} from "@/components/kumo/metric-grid";

/**
 * The one honest metric tile.
 *
 * Renders the shared `MetricTile` contract (`@tedix/api-contract`) into a Kumo
 * `MetricItem`. A measured tile always carries its `window · source` caption in
 * the provenance slot — the contract cannot express a value without both, and
 * the runtime `safeParse` re-checks tiles that arrive from outside the type
 * system, so an invalid tile degrades to "Not measured" and can never render a
 * bare value. An `empty` tile renders its stated reason plus an optional
 * "Set up" link instead of a number.
 *
 * Callers keep grid concerns (`emphasis`, `className`, `data-*`, `valueTone`)
 * through the usual MetricItem props.
 */
type MetricTileProps = Omit<
	MetricItemProps,
	"children" | "description" | "label" | "value"
> & {
	tile: MetricTileData;
};

/** The label a malformed tile can still honestly show, when it has one. */
function fallbackLabel(tile: unknown): string {
	if (
		typeof tile === "object" &&
		tile !== null &&
		"label" in tile &&
		typeof tile.label === "string" &&
		tile.label.length > 0
	) {
		return tile.label;
	}
	return "Metric";
}

export function MetricTile({ tile, ...props }: MetricTileProps) {
	const parsed = MetricTileSchema.safeParse(tile);
	if (!parsed.success) {
		return (
			<MetricItem
				label={fallbackLabel(tile)}
				value="Not measured"
				valueTone="secondary"
				description="This figure has no verified window or source."
				{...props}
			/>
		);
	}
	const data = parsed.data;
	if (data.state === "empty") {
		return (
			<MetricItem
				label={data.label}
				value={data.emptyReason}
				// A reason is prose: break between words, never inside one.
				valueClassName="wrap-break-word"
				valueTone="secondary"
				description={
					data.setupHref ? (
						<Link href={data.setupHref}>{data.setupLabel ?? "Set up"}</Link>
					) : undefined
				}
				{...props}
			/>
		);
	}
	return (
		<MetricItem
			label={data.label}
			value={
				data.href ? <Link href={data.href}>{data.value}</Link> : data.value
			}
			description={
				<>
					{data.qualifier ? (
						<span className="block">{data.qualifier}</span>
					) : null}
					<span className="block" data-slot="metric-provenance">
						{data.window} · {data.source}
					</span>
				</>
			}
			{...props}
		/>
	);
}

export type { MetricTileProps };
