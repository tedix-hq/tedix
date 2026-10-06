import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Card, CardContent } from "@tedix/widget-ui/card";
import { safeLinkHref } from "@tedix/widget-ui/safe-url";

export type KeyValuePanelTone =
	| "default"
	| "success"
	| "warning"
	| "danger"
	| "info";

export interface KeyValueItem {
	label: string;
	value?: boolean | number | string | null;
	description?: string | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	tone?: KeyValuePanelTone | null;
	href?: string | null;
}

interface KeyValuePanelProps {
	items?: KeyValueItem[] | null;
	title?: string | null;
	description?: string | null;
	columns?: 1 | 2 | 3 | null;
	density?: "compact" | "comfortable" | null;
	variant?: "card" | "plain" | null;
}

const toneText: Record<KeyValuePanelTone, string> = {
	default: "text-foreground",
	success: "text-success",
	warning: "text-warning",
	danger: "text-destructive",
	info: "text-info",
};

export function KeyValuePanelComponent({
	items,
	title,
	description,
	columns,
	density,
	variant,
}: KeyValuePanelProps) {
	const safeItems = Array.isArray(items) ? items : [];
	const compact = density === "compact";
	const gridColumns = columnClass(columns ?? 1);
	const content = (
		<div
			className={`${gridColumns} grid gap-x-5 ${compact ? "gap-y-2" : "gap-y-3"}`}
		>
			{safeItems.map((item, index) => (
				<KeyValueRow
					key={`${item.label}-${index}`}
					item={item}
					compact={compact}
				/>
			))}
		</div>
	);

	if (safeItems.length === 0) {
		return <EmptyPrimitiveState label="No details" />;
	}

	if (variant === "plain") {
		return (
			<div className="space-y-3">
				<PrimitiveHeader title={title} description={description} />
				{content}
			</div>
		);
	}

	return (
		<Card size="sm">
			<CardContent className="space-y-4">
				<PrimitiveHeader title={title} description={description} />
				{content}
			</CardContent>
		</Card>
	);
}

function KeyValueRow({
	item,
	compact,
}: {
	item: KeyValueItem;
	compact: boolean;
}) {
	const tone = item.tone ?? "default";
	const value = formatValue(item.value);
	// `items[].href` is spec-authored and the catalog types it as a bare
	// `z.string()`, so this is the most direct model -> href path in the app.
	// A rejected value renders the plain <span> branch.
	const href = safeLinkHref(item.href);
	const ValueTag = href ? "a" : "span";
	const valueProps = href
		? {
				href,
				target: "_blank",
				rel: "noopener noreferrer",
			}
		: {};

	return (
		<div
			className={`min-w-0 border-border/70 border-b ${compact ? "pb-2" : "pb-3"} last:border-b-0 last:pb-0`}
		>
			<div className="flex min-w-0 items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-muted-foreground text-xs uppercase tracking-normal">
						{item.label}
					</p>
					<ValueTag
						{...valueProps}
						className={`mt-1 block break-words font-medium text-sm leading-snug ${toneText[tone]} ${href ? "underline-offset-4 hover:underline" : ""}`}
					>
						{value}
					</ValueTag>
				</div>
				{item.badge && (
					<Badge pill variant={item.badgeVariant ?? toneToBadgeVariant(tone)}>
						{item.badge}
					</Badge>
				)}
			</div>
			{item.description && (
				<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
					{item.description}
				</p>
			)}
		</div>
	);
}

function PrimitiveHeader({
	title,
	description,
}: {
	title?: string | null;
	description?: string | null;
}) {
	if (!title && !description) return null;
	return (
		<div className="space-y-1">
			{title && (
				<h3 className="font-semibold text-base text-foreground">{title}</h3>
			)}
			{description && (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{description}
				</p>
			)}
		</div>
	);
}

function EmptyPrimitiveState({ label }: { label: string }) {
	return (
		<div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-muted-foreground text-sm">
			{label}
		</div>
	);
}

function columnClass(count: 1 | 2 | 3): string {
	if (count === 2) return "md:grid-cols-2";
	if (count === 3) return "md:grid-cols-2 lg:grid-cols-3";
	return "grid-cols-1";
}

function toneToBadgeVariant(tone: KeyValuePanelTone): BadgeVariant {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "danger") return "destructive";
	if (tone === "info") return "info";
	return "secondary";
}

function formatValue(value: KeyValueItem["value"]): string {
	if (value == null || value === "") return "-";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number")
		return new Intl.NumberFormat("en-US").format(value);
	return value;
}
