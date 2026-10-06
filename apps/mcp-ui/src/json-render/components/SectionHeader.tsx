import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Button } from "@tedix/widget-ui/button";

export type SectionHeaderAlign = "left" | "center" | "right";
export type SectionHeaderDensity = "compact" | "comfortable";

interface SectionHeaderProps {
	title?: string | null;
	description?: string | null;
	eyebrow?: string | null;
	meta?: string | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	actionLabel?: string | null;
	align?: SectionHeaderAlign | null;
	density?: SectionHeaderDensity | null;
	divider?: boolean | null;
	onAction?: () => void;
}

const alignmentClass: Record<SectionHeaderAlign, string> = {
	left: "items-start text-left",
	center: "items-center text-center",
	right: "items-end text-right",
};

export function SectionHeaderComponent({
	title,
	description,
	eyebrow,
	meta,
	badge,
	badgeVariant,
	actionLabel,
	align,
	density,
	divider,
	onAction,
}: SectionHeaderProps) {
	const resolvedAlign = align ?? "left";
	const compact = density === "compact";
	const hasPrimaryContent = !!(
		title ||
		description ||
		eyebrow ||
		badge ||
		meta
	);

	if (!hasPrimaryContent && !actionLabel) return null;

	return (
		<div
			className={[
				"min-w-0",
				divider ? "border-border/70 border-b pb-3" : "",
				compact ? "space-y-1.5" : "space-y-2",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<div
				className={[
					"flex min-w-0 gap-3",
					resolvedAlign === "center"
						? "flex-col"
						: "flex-col sm:flex-row sm:items-start sm:justify-between",
				]
					.filter(Boolean)
					.join(" ")}
			>
				<div
					className={`flex min-w-0 flex-col ${compact ? "gap-1" : "gap-1.5"} ${alignmentClass[resolvedAlign]}`}
				>
					{(eyebrow || badge || meta) && (
						<div
							className={[
								"flex min-w-0 flex-wrap items-center gap-2",
								resolvedAlign === "center"
									? "justify-center"
									: resolvedAlign === "right"
										? "justify-end"
										: "justify-start",
							].join(" ")}
						>
							{eyebrow && (
								<span className="font-medium text-muted-foreground text-xs uppercase tracking-normal">
									{eyebrow}
								</span>
							)}
							{badge && (
								<Badge pill variant={badgeVariant ?? "secondary"}>
									{badge}
								</Badge>
							)}
							{meta && (
								<span className="text-muted-foreground text-xs">{meta}</span>
							)}
						</div>
					)}
					{title && (
						<h2
							className={`break-words font-semibold text-foreground leading-tight ${compact ? "text-base" : "text-lg"}`}
						>
							{title}
						</h2>
					)}
					{description && (
						<p
							className={`max-w-2xl text-muted-foreground leading-relaxed ${compact ? "text-xs" : "text-sm"}`}
						>
							{description}
						</p>
					)}
				</div>
				{actionLabel && (
					<Button
						className={
							resolvedAlign === "center"
								? "self-center"
								: "self-start sm:self-auto"
						}
						size="sm"
						variant="outline"
						onClick={onAction}
					>
						{actionLabel}
					</Button>
				)}
			</div>
		</div>
	);
}
