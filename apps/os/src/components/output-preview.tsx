import { LockKey, VideoCamera } from "@phosphor-icons/react";
import type { OsOutputLibraryPreview } from "@tedix/api-contract/schemas/os-workspaces";
import { Text } from "@/components/kumo/text";

function previewValue(value: string | number | boolean | null): string {
	return value === null ? "" : String(value);
}

function DocumentPreview({
	preview,
}: {
	preview: Extract<OsOutputLibraryPreview, { kind: "document" }>;
}) {
	return (
		<div
			className="grid h-full content-start gap-2 bg-kumo-elevated px-5 py-4"
			aria-hidden="true"
		>
			<div className="h-2 w-20 rounded-full bg-kumo-brand/25" />
			{preview.lines.length > 0 ? (
				preview.lines.slice(0, 5).map((line, index) => (
					<div
						key={`${index}-${line}`}
						className={
							index === 0
								? "truncate font-semibold text-kumo-strong text-xs"
								: "truncate text-[10px] text-kumo-subtle"
						}
					>
						{line}
					</div>
				))
			) : (
				<div className="text-kumo-inactive text-xs">Empty document</div>
			)}
		</div>
	);
}

function SheetPreview({
	preview,
}: {
	preview: Extract<OsOutputLibraryPreview, { kind: "sheet" }>;
}) {
	const columnCount = Math.max(preview.columns.length, 1);
	return (
		<div
			className="h-full overflow-hidden bg-kumo-elevated p-3"
			aria-hidden="true"
		>
			<div
				className="grid min-w-0 rounded-md border border-kumo-line bg-kumo-base text-[9px]"
				style={{
					gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
				}}
			>
				{(preview.columns.length > 0 ? preview.columns : ["Sheet"]).map(
					(column, index) => (
						<div
							key={`${index}-${column}`}
							className="truncate border-kumo-line border-r border-b bg-kumo-tint px-1.5 py-1 font-semibold text-kumo-subtle last:border-r-0"
						>
							{column}
						</div>
					),
				)}
				{preview.rows.flatMap((row, rowIndex) =>
					Array.from({ length: columnCount }, (_, columnIndex) => (
						<div
							key={`${rowIndex}-${columnIndex}`}
							className="truncate border-kumo-hairline border-r border-b px-1.5 py-1 text-kumo-subtle last:border-r-0"
						>
							{previewValue(row[columnIndex] ?? null)}
						</div>
					)),
				)}
			</div>
		</div>
	);
}

function PresentationPreview({
	preview,
}: {
	preview: Extract<OsOutputLibraryPreview, { kind: "presentation" }>;
}) {
	return (
		<div
			className="flex h-full items-center justify-center bg-gradient-to-br from-kumo-brand/15 via-kumo-elevated to-kumo-tint p-4"
			aria-hidden="true"
		>
			<div className="aspect-video max-h-full w-full overflow-hidden rounded-md border border-kumo-line bg-kumo-base p-3 shadow-tedix-raised">
				<div className="truncate font-semibold text-[11px] text-kumo-strong">
					{preview.title || "Untitled slide"}
				</div>
				<ul className="mt-2 grid list-disc gap-1 pl-3 text-[9px] text-kumo-subtle">
					{preview.bullets.slice(0, 3).map((bullet, index) => (
						<li key={`${index}-${bullet}`} className="truncate">
							{bullet}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

export function OutputPreview({
	preview,
}: {
	preview: OsOutputLibraryPreview;
}) {
	if (preview.kind === "unavailable") {
		return (
			<div className="flex h-full items-center justify-center bg-kumo-tint">
				<div className="grid justify-items-center gap-2 px-4 text-center">
					<LockKey size={32} weight="duotone" aria-hidden="true" />
					<Text as="span" role="label" tone="secondary">
						Source access unavailable
					</Text>
				</div>
			</div>
		);
	}
	if (preview.kind === "document") return <DocumentPreview preview={preview} />;
	if (preview.kind === "sheet") return <SheetPreview preview={preview} />;
	if (preview.kind === "video") {
		return (
			<div className="flex h-full items-center justify-center bg-black text-white">
				<div className="grid justify-items-center gap-2 px-4 text-center">
					<VideoCamera size={32} weight="duotone" />
					<Text as="span" role="label" className="line-clamp-2">
						{preview.caption ?? "MP4 video"}
					</Text>
				</div>
			</div>
		);
	}
	return <PresentationPreview preview={preview} />;
}
