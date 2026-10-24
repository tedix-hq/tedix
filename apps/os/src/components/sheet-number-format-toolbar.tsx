import { Coins, Percent } from "@phosphor-icons/react";
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
import { formatWorkbookValue } from "@/lib/workbook-formulas";

type NumberFormat = NonNullable<OsWorkbookCellFormat["numberFormat"]>;

const formats: readonly (readonly [NumberFormat, string])[] = [
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
];

/** 26 Sept 2025, 15:54 as a spreadsheet serial: one sample for every format. */
const SAMPLE_SERIAL = 45926.6625;
const SAMPLE_NUMBER = 1234.5;

/** What each format does to a value, in the workbook's own locale and currency. */
function formatExample(
	numberFormat: NumberFormat,
	context: WorkbookNumberContext | undefined,
): string {
	if (numberFormat === "automatic" || numberFormat === "text") return "";
	const value = ["date", "time", "datetime"].includes(numberFormat)
		? SAMPLE_SERIAL
		: numberFormat === "percent"
			? 0.125
			: SAMPLE_NUMBER;
	return formatWorkbookValue(
		{ input: String(value), value, format: { numberFormat } },
		context,
	);
}

/**
 * Decimal-place glyphs: a baseline dot, one or two zeros, and an arrow saying
 * which way the precision moves. Drawn as paths so the toolbar stays text-free.
 */
function DecimalsIcon({ more }: { more: boolean }) {
	return (
		<svg
			width="18"
			height="16"
			viewBox="0 0 18 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="2" cy="10.5" r="0.9" fill="currentColor" stroke="none" />
			<ellipse cx="6.2" cy="8" rx="1.9" ry="2.9" />
			{more ? <ellipse cx="11.6" cy="8" rx="1.9" ry="2.9" /> : null}
			{more ? (
				<path d="M13.5 14h4m-1.5-1.5L17.5 14 16 15.5" />
			) : (
				<path d="M13 14H9m1.5-1.5L9 14l1.5 1.5" />
			)}
		</svg>
	);
}

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
	const fixedPrecision = ["date", "time", "datetime", "text"].includes(current);
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
						numberFormat: value as NumberFormat,
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
					{formats.map(([id, label]) => {
						const example = formatExample(id, context);
						return (
							<SelectItem key={id} value={id}>
								<span className="flex w-full min-w-48 items-baseline justify-between gap-6">
									<span>{label}</span>
									{example ? (
										<span className="text-kumo-subtle tabular-nums type-tedix-caption">
											{example}
										</span>
									) : null}
								</span>
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
			{(
				[
					["currency", "Currency", Coins],
					["percent", "Percent", Percent],
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
				disabled={disabled || decimals === 0 || fixedPrecision}
				onClick={() => changeDecimals(-1)}
			>
				<DecimalsIcon more={false} />
			</EditorToolbarButton>
			<EditorToolbarButton
				label="Increase decimals"
				disabled={disabled || decimals === 15 || fixedPrecision}
				onClick={() => changeDecimals(1)}
			>
				<DecimalsIcon more />
			</EditorToolbarButton>
		</>
	);
}
