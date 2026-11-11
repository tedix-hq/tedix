import type { OsWorkbookCellFormat } from "@tedix/api-contract/schemas/os-workspaces";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";

const SIZES = [6, 8, 10, 12, 14, 16, 18, 24, 32, 48, 64, 96];

export function SheetFontSizeControl({
	format,
	disabled,
	onChange,
}: {
	format?: OsWorkbookCellFormat;
	disabled?: boolean;
	onChange: (format: Partial<OsWorkbookCellFormat>) => void;
}) {
	const current = format?.fontSize;
	const sizes = [
		...new Set([...SIZES, ...(current === undefined ? [] : [current])]),
	].sort((a, b) => a - b);
	return (
		<Select
			disabled={disabled}
			value={current === undefined ? "default" : String(current)}
			onValueChange={(value) =>
				onChange({ fontSize: value === "default" ? undefined : Number(value) })
			}
		>
			<SelectTrigger aria-label="Cell text size" size="sm" className="w-24">
				<SelectValue>
					{(value) => (value === "default" ? "Default" : `${value} px`)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="default">Default</SelectItem>
				{sizes.map((size) => (
					<SelectItem key={size} value={String(size)}>
						{size} px
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
