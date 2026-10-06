declare module "hot-formula-parser" {
	export interface FormulaCoordinate {
		label: string;
		row: { index: number; isAbsolute: boolean };
		column: { index: number; isAbsolute: boolean };
	}

	export interface FormulaParseResult {
		result: unknown;
		error: string | null;
	}

	export class Parser {
		parse(expression: string): FormulaParseResult;
		setVariable(name: string, value: unknown): void;
		on(
			event: "callCellValue",
			listener: (
				coordinate: FormulaCoordinate,
				done: (value: unknown) => void,
			) => void,
		): void;
		on(
			event: "callRangeValue",
			listener: (
				start: FormulaCoordinate,
				end: FormulaCoordinate,
				done: (value: unknown[][]) => void,
			) => void,
		): void;
	}

	export const SUPPORTED_FORMULAS: readonly string[];
}
