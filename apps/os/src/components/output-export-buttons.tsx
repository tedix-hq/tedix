import { DownloadSimple } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import {
	type OsOutputExportFormat,
	type OsOutputKind,
	osOutputExportFormatsForKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@/components/kumo/dropdown-menu";
import { osApi, OS_API_URL } from "@/lib/api";

/**
 * A format is offered only for the kinds it can actually carry — there is no
 * `.xlsx` of a slide deck. The applicability table lives in the contract
 * package and the router enforces it, so this is presentation, not the gate.
 */
export function OutputExportButtons({
	outputId,
	kind,
	compact = false,
}: {
	outputId: string;
	/**
	 * The output's kind. Every call site renders inside its own loaded output
	 * detail, so the kind is always known by the time these buttons exist and
	 * this component never resolves it a second time.
	 */
	kind: OsOutputKind;
	compact?: boolean;
}) {
	const exportOutput = useMutation({
		mutationFn: (format: OsOutputExportFormat) =>
			osApi.osWorkspaces.outputs.export({ outputId, format }),
		onSuccess: (result) => {
			const exportUrl = new URL(result.url);
			// Keep downloads on the same authenticated API proxy as the export call.
			const download = document.createElement("a");
			download.href = `${OS_API_URL}${exportUrl.pathname}${exportUrl.search}`;
			download.download = exportUrl.pathname.split("/").pop() ?? "export";
			download.click();
		},
	});
	const activeFormat = exportOutput.isPending ? exportOutput.variables : null;
	const formats: OsOutputExportFormat[] = osOutputExportFormatsForKind(kind);
	const labels: Partial<Record<OsOutputExportFormat, string>> = {
		docx: "Word (.docx)",
		xlsx: "Excel (.xlsx)",
		pptx: "PowerPoint (.pptx)",
	};
	return (
		<div className="flex items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="sm"
							variant="secondary"
							disabled={exportOutput.isPending}
							aria-label={
								activeFormat
									? `Exporting ${activeFormat.toUpperCase()}`
									: "Export"
							}
							aria-busy={exportOutput.isPending || undefined}
						/>
					}
				>
					<DownloadSimple size={14} />
					{activeFormat ? `Exporting ${activeFormat.toUpperCase()}…` : "Export"}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{formats.map((format) => (
						<DropdownMenuItem
							key={format}
							disabled={exportOutput.isPending}
							onClick={() => exportOutput.mutate(format)}
						>
							{labels[format] ?? format.toUpperCase()}
						</DropdownMenuItem>
					))}
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
							? "max-w-48 text-xs text-kumo-danger"
							: "text-sm text-kumo-danger"
					}
					role="alert"
				>
					Export failed: {(exportOutput.error as Error).message}
				</span>
			) : null}
		</div>
	);
}
