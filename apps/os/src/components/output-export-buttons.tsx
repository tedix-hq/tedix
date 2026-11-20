import type { ReactNode } from "react";
import { DotsThree, DownloadSimple } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import {
	type OsOutputExportFormat,
	type OsOutputContent,
	type OsOutputKind,
	osOutputExportFormatsForKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/kumo/dropdown-menu";
import {
	blobToBase64,
	type DriveSaveTarget,
	saveExportToDrive,
	useDriveSaveTargets,
} from "@/components/save-to-drive";
import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";
import { osApi, OS_API_URL } from "@/lib/api";

/**
 * A format is offered only for the kinds it can actually carry — there is no
 * `.xlsx` of a slide deck. The applicability table lives in the contract
 * package and the router enforces it, so this is presentation, not the gate.
 */
const FORMAT_LABELS: Partial<Record<OsOutputExportFormat, string>> = {
	docx: "Document (.docx)",
	xlsx: "Workbook (.xlsx)",
	pptx: "Slides (.pptx)",
	markdown: "Markdown (.md)",
	html: "HTML (.html)",
	csv: "CSV (all sheets)",
};

type ExportRequest = {
	format: OsOutputExportFormat;
	sheetId?: string;
	revisionHeader?: boolean;
};

/** The format a file opens in on a drive: its office format. */
const DRIVE_FORMATS: Partial<Record<OsOutputKind, OsOutputExportFormat>> = {
	document: "docx",
	sheet: "xlsx",
	presentation: "pptx",
};

/** Export the file on the server, read it back, and save it to the person's drive. */
async function saveOutputToDrive(
	output: { id: string; title?: string },
	format: OsOutputExportFormat,
	target: DriveSaveTarget,
) {
	const result = await osApi.osWorkspaces.outputs.export({
		outputId: output.id,
		format,
	});
	const exportUrl = new URL(result.url);
	const exportName = exportUrl.pathname.split("/").pop() || `export.${format}`;
	const extension = exportName.slice(exportName.lastIndexOf("."));
	const response = await fetch(
		`${OS_API_URL}${exportUrl.pathname}${exportUrl.search}`,
		{ credentials: "include" },
	);
	if (!response.ok) throw new Error("The exported file could not be read.");
	const blob = await response.blob();
	if (blob.size > OS_OUTPUT_CONTENT_MAX_BYTES)
		throw new Error("This file is too large to save to a drive.");
	await saveExportToDrive(target, {
		fileName: output.title?.trim()
			? `${output.title.trim().slice(0, 200)}${extension}`
			: exportName,
		mimeType: blob.type.split(";")[0] || "application/octet-stream",
		content: { encoding: "base64", data: await blobToBase64(blob) },
	});
}

export function OutputExportButtons({
	outputId,
	title,
	kind,
	content,
	compact = false,
	phoneOverflow = false,
	phoneActions,
}: {
	outputId: string;
	/** The file's name, used for the copy saved to a drive. */
	title?: string;
	/**
	 * The output's kind. Every call site renders inside its own loaded output
	 * detail, so the kind is always known by the time these buttons exist and
	 * this component never resolves it a second time.
	 */
	kind: OsOutputKind;
	content?: OsOutputContent;
	compact?: boolean;
	phoneOverflow?: boolean;
	phoneActions?: ReactNode;
}) {
	const exportOutput = useMutation({
		mutationFn: ({ format, sheetId, revisionHeader }: ExportRequest) =>
			osApi.osWorkspaces.outputs.export({
				outputId,
				format,
				...(sheetId ? { sheetId } : {}),
				...(revisionHeader ? { revisionHeader } : {}),
			}),
		onSuccess: (result) => {
			const exportUrl = new URL(result.url);
			// Keep downloads on the same authenticated API proxy as the export call.
			const download = document.createElement("a");
			download.href = `${OS_API_URL}${exportUrl.pathname}${exportUrl.search}`;
			download.download = exportUrl.pathname.split("/").pop() ?? "export";
			download.click();
		},
	});
	const driveTargets = useDriveSaveTargets();
	const driveFormat = DRIVE_FORMATS[kind];
	const saveToDrive = useMutation({
		mutationFn: (target: DriveSaveTarget) =>
			saveOutputToDrive({ id: outputId, title }, driveFormat!, target),
	});
	const activeFormat = exportOutput.isPending
		? exportOutput.variables?.format
		: saveToDrive.isPending
			? driveFormat
			: null;
	const formats: OsOutputExportFormat[] = osOutputExportFormatsForKind(kind);
	const sheets =
		content?.kind === "sheet" ? content.workbook?.sheets : undefined;
	return (
		<div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="sm"
							className={phoneOverflow ? "output-detail-overflow" : undefined}
							variant="secondary"
							disabled={exportOutput.isPending || saveToDrive.isPending}
							aria-label={
								activeFormat
									? `Exporting ${activeFormat.toUpperCase()}`
									: phoneOverflow
										? "Output actions"
										: "Export"
							}
							aria-busy={exportOutput.isPending || undefined}
						/>
					}
				>
					{phoneOverflow ? <DotsThree size={18} className="sm:hidden" /> : null}
					<span
						className={
							phoneOverflow
								? "hidden sm:inline-flex items-center gap-1"
								: "inline-flex items-center gap-1"
						}
					>
						<DownloadSimple size={14} />
						{activeFormat
							? `Exporting ${activeFormat.toUpperCase()}…`
							: "Export"}
					</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{phoneActions}
					{formats.map((format) => (
						<DropdownMenuItem
							key={format}
							disabled={exportOutput.isPending}
							onClick={() => exportOutput.mutate({ format })}
						>
							{FORMAT_LABELS[format] ?? format.toUpperCase()}
						</DropdownMenuItem>
					))}
					{kind === "document" || kind === "sheet" ? (
						<DropdownMenuItem
							disabled={exportOutput.isPending}
							onClick={() =>
								exportOutput.mutate({ format: "pdf", revisionHeader: true })
							}
						>
							PDF with title and revision
						</DropdownMenuItem>
					) : null}
					{sheets && sheets.length > 1
						? sheets.map((sheet) => (
								<DropdownMenuItem
									key={sheet.id}
									disabled={exportOutput.isPending}
									onClick={() =>
										exportOutput.mutate({
											format: "csv",
											sheetId: sheet.id,
										})
									}
								>
									CSV ({sheet.name})
								</DropdownMenuItem>
							))
						: null}
					{driveFormat && driveTargets.length ? (
						<>
							<DropdownMenuSeparator />
							{driveTargets.map((target) => (
								<DropdownMenuItem
									key={target.provider}
									disabled={exportOutput.isPending || saveToDrive.isPending}
									onClick={() => saveToDrive.mutate(target)}
								>
									{target.label} ({FORMAT_LABELS[driveFormat]})
								</DropdownMenuItem>
							))}
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{activeFormat ? (
				<span className="sr-only" role="status">
					Exporting {activeFormat.toUpperCase()}
				</span>
			) : null}
			{exportOutput.isError ? (
				<span
					className={
						compact
							? "min-w-0 max-w-48 text-xs text-kumo-danger [overflow-wrap:anywhere]"
							: "min-w-0 max-w-full text-sm text-kumo-danger [overflow-wrap:anywhere]"
					}
					role="alert"
				>
					Export failed: {(exportOutput.error as Error).message}
				</span>
			) : null}
			{saveToDrive.isError ? (
				<span
					className={
						compact
							? "min-w-0 max-w-48 text-xs text-kumo-danger [overflow-wrap:anywhere]"
							: "min-w-0 max-w-full text-sm text-kumo-danger [overflow-wrap:anywhere]"
					}
					role="alert"
				>
					Could not save to the drive: {saveToDrive.error.message}
				</span>
			) : null}
		</div>
	);
}
