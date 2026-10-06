import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Card, CardContent } from "@tedix/widget-ui/card";

export type TimelineStatus =
	| "completed"
	| "current"
	| "pending"
	| "warning"
	| "error"
	| "info";

export interface StatusTimelineItem {
	title: string;
	description?: string | null;
	timestamp?: string | null;
	status?: TimelineStatus | null;
	statusLabel?: string | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	meta?: string | null;
}

interface StatusTimelineProps {
	items?: StatusTimelineItem[] | null;
	title?: string | null;
	description?: string | null;
	density?: "compact" | "comfortable" | null;
	showConnectors?: boolean | null;
	variant?: "card" | "plain" | null;
}

const statusDot: Record<TimelineStatus, string> = {
	completed: "border-success bg-success",
	current: "border-primary bg-primary",
	pending: "border-muted-foreground bg-background",
	warning: "border-warning bg-warning",
	error: "border-destructive bg-destructive",
	info: "border-info bg-info",
};

const statusText: Record<TimelineStatus, string> = {
	completed: "text-success",
	current: "text-primary",
	pending: "text-muted-foreground",
	warning: "text-warning",
	error: "text-destructive",
	info: "text-info",
};

export function StatusTimelineComponent({
	items,
	title,
	description,
	density,
	showConnectors,
	variant,
}: StatusTimelineProps) {
	const safeItems = Array.isArray(items) ? items : [];
	const compact = density === "compact";
	const connectors = showConnectors !== false;
	const content = (
		<div className="space-y-0">
			{safeItems.map((item, index) => (
				<TimelineRow
					key={`${item.title}-${index}`}
					item={item}
					compact={compact}
					showConnector={connectors && index < safeItems.length - 1}
				/>
			))}
		</div>
	);

	if (safeItems.length === 0) {
		return <EmptyPrimitiveState label="No timeline events" />;
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

function TimelineRow({
	item,
	compact,
	showConnector,
}: {
	item: StatusTimelineItem;
	compact: boolean;
	showConnector: boolean;
}) {
	const status = item.status ?? "pending";

	return (
		<div className="grid grid-cols-[1rem_1fr] gap-3">
			<div className="relative flex justify-center">
				<span
					className={`mt-1.5 h-3 w-3 rounded-full border-2 ${statusDot[status]}`}
					aria-hidden="true"
				/>
				{showConnector && (
					<span
						className="absolute top-5 bottom-0 w-px bg-border"
						aria-hidden="true"
					/>
				)}
			</div>
			<div className={`${compact ? "pb-3" : "pb-5"} min-w-0`}>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<h4 className="min-w-0 font-medium text-foreground text-sm leading-snug">
						{item.title}
					</h4>
					{item.statusLabel && (
						<span className={`font-medium text-xs ${statusText[status]}`}>
							{item.statusLabel}
						</span>
					)}
					{item.badge && (
						<Badge
							pill
							variant={item.badgeVariant ?? statusToBadgeVariant(status)}
						>
							{item.badge}
						</Badge>
					)}
				</div>
				{(item.timestamp || item.meta) && (
					<p className="mt-1 text-muted-foreground text-xs">
						{[item.timestamp, item.meta].filter(Boolean).join(" / ")}
					</p>
				)}
				{item.description && (
					<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
						{item.description}
					</p>
				)}
			</div>
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

function statusToBadgeVariant(status: TimelineStatus): BadgeVariant {
	if (status === "completed") return "success";
	if (status === "warning") return "warning";
	if (status === "error") return "destructive";
	if (status === "current" || status === "info") return "info";
	return "secondary";
}
