import type { ReactNode } from "react";
import { Surface } from "@/components/kumo/surface";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { cn } from "@/lib/utils";
import "./outputs-page.css";

export function ResourceCard({
	title,
	label,
	preview,
	children,
	actions,
	selected = false,
	disabled = false,
	layout = "grid",
	onOpen,
	resourceId,
	asListItem = false,
	openLabel = "Open",
	bodyClassName,
}: {
	title?: string;
	label: string;
	preview?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	selected?: boolean;
	disabled?: boolean;
	layout?: "grid" | "list";
	onOpen?: () => void;
	resourceId?: string;
	asListItem?: boolean;
	openLabel?: string;
	bodyClassName?: string;
}) {
	return (
		<Surface
			tier="panel"
			render={asListItem ? <li /> : <div />}
			aria-label={label}
			aria-disabled={disabled || undefined}
			data-resource-card={resourceId ?? ""}
			data-workspace-app={resourceId}
			aria-current={selected || undefined}
			className={cn(
				"resource-card group relative min-w-0 overflow-visible outline-none",
				layout === "grid"
					? "output-grid-card"
					: "output-list-row flex min-h-16 items-center gap-3 px-3 py-2.5",
				selected && "bg-kumo-control",
				!disabled && "hover:border-kumo-fill",
			)}
		>
			{layout === "grid" && preview && (
				<div
					data-slot="output-grid-preview"
					className="aspect-video overflow-hidden rounded-t-xl border-kumo-line border-b"
				>
					{preview}
				</div>
			)}
			<div
				className={cn(
					layout === "list" ? "contents" : "min-w-0 flex-1",
					layout === "grid" && "output-card-footer grid gap-2 p-4",
					bodyClassName,
				)}
			>
				{title && (
					<Text
						as="h3"
						role="control"
						tone="strong"
						weight="medium"
						className="wrap-anywhere"
					>
						{title}
					</Text>
				)}
				{children}
				{actions ??
					(onOpen && (
						<div className="output-card-actions workspace-app-footer flex">
							<Button
								disabled={disabled}
								variant="ghost"
								size="sm"
								aria-label={label}
								onClick={onOpen}
								className="output-card-open static after:absolute after:inset-px after:content-['']"
							>
								{openLabel}
							</Button>
						</div>
					))}
			</div>
		</Surface>
	);
}
