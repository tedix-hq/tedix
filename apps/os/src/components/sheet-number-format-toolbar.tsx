import {
	ArrowLeft,
	ArrowRight,
	CalendarBlank,
	Clock,
	CalendarDots,
	Coins,
	Hash,
	Percent,
	TextAa,
} from "@phosphor-icons/react";
import {
	workbookDecimals,
	type WorkbookNumberContext,
} from "@tedix/api-contract/utils/workbook-number-format";
import type { OsWorkbookCellFormat } from "@tedix/api-contract/schemas/os-workspaces";
import { EditorToolbarButton } from "@/components/output-editor-toolbar";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";

const formats = [
	["automatic", "Automatic"],
	["number", "Number"],
	["integer", "Integer"],
	["currency", "Currency"],
	["percent", "Percent"],
	["scientific", "Scientific"],
	["date", "Date"],
	["time", "Time"],
	["datetime", "Date and time"],
	["text", "Plain text"],
] as const;

export function SheetNumberFormatToolbar({
	format,
	context,
	disabled,
	onChange,
}: {
	format?: OsWorkbookCellFormat;
	context?: WorkbookNumberContext;
	disabled?: boolean;
	onChange: (format: Partial<OsWorkbookCellFormat>) => void;
}) {
	const current = format?.numberFormat ?? "automatic";
	const decimals = workbookDecimals(format ?? {}, context);
	const changeDecimals = (delta: number) =>
		onChange({
			numberFormat:
				current === "automatic" || current === "integer" ? "number" : current,
			decimals: Math.max(0, Math.min(15, decimals + delta)),
		});
	return (
		<>
			<Select
				disabled={disabled}
				value={current}
				onValueChange={(value) =>
					onChange({
						numberFormat: value as OsWorkbookCellFormat["numberFormat"],
						decimals: undefined,
					})
				}
			>
				<SelectTrigger aria-label="Number format" className="w-32" size="sm">
					<SelectValue>
						{(value) =>
							formats.find(([id]) => id === value)?.[1] ?? "Automatic"
						}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{formats.map(([id, label]) => (
						<SelectItem key={id} value={id}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{(
				[
					["currency", "Currency", Coins],
					["integer", "Integer", Hash],
					["percent", "Percent", Percent],
					["date", "Date", CalendarBlank],
					["time", "Time", Clock],
					["datetime", "Date and time", CalendarDots],
					["text", "Plain text", TextAa],
				] as const
			).map(([numberFormat, label, Icon]) => (
				<EditorToolbarButton
					key={numberFormat}
					label={label}
					active={current === numberFormat}
					disabled={disabled}
					onClick={() => onChange({ numberFormat, decimals: undefined })}
				>
					<Icon size={15} />
				</EditorToolbarButton>
			))}
			<EditorToolbarButton
				label="Decrease decimals"
				disabled={
					disabled ||
					decimals === 0 ||
					["date", "time", "datetime", "text"].includes(current)
				}
				onClick={() => changeDecimals(-1)}
			>
				<ArrowLeft size={15} />
			</EditorToolbarButton>
			<EditorToolbarButton
				label="Increase decimals"
				disabled={
					disabled ||
					decimals === 15 ||
					["date", "time", "datetime", "text"].includes(current)
				}
				onClick={() => changeDecimals(1)}
			>
				<ArrowRight size={15} />
			</EditorToolbarButton>
		</>
	);
}
