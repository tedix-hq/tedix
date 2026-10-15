import type {
	OsWorkbookCell,
	OsWorkbookCellFormat,
} from "../schemas/os-workspaces";

export interface WorkbookNumberContext {
	locale?: string;
	currency?: string;
}

// Excel's fictitious 1900-02-29 occupies serial 60; all later dates retain it.
export function spreadsheetDate(serial: number): Date {
	return new Date(
		Date.UTC(1899, 11, 31) + (serial - (serial >= 60 ? 1 : 0)) * 86400000,
	);
}

export function spreadsheetSerial(date: Date): number {
	const days = (date.getTime() - Date.UTC(1899, 11, 31)) / 86400000;
	return days + (days >= 60 ? 1 : 0);
}

export function workbookCurrency(context: WorkbookNumberContext): string {
	if (context.currency) return context.currency;
	const locale = new Intl.Locale(
		context.locale ?? new Intl.NumberFormat().resolvedOptions().locale,
	);
	const region = locale.maximize().region ?? "";
	if (
		[
			"AT",
			"BE",
			"CY",
			"DE",
			"EE",
			"ES",
			"FI",
			"FR",
			"GR",
			"HR",
			"IE",
			"IT",
			"LT",
			"LU",
			"LV",
			"MT",
			"NL",
			"PT",
			"SI",
			"SK",
		].includes(region)
	)
		return "EUR";
	const currencies: Record<string, string> = {
		US: "USD",
		GB: "GBP",
		CA: "CAD",
		AU: "AUD",
		NZ: "NZD",
		CH: "CHF",
		JP: "JPY",
		CN: "CNY",
		IN: "INR",
		BR: "BRL",
		MX: "MXN",
		CO: "COP",
		AR: "ARS",
		CL: "CLP",
		PE: "PEN",
		SE: "SEK",
		NO: "NOK",
		DK: "DKK",
		PL: "PLN",
		CZ: "CZK",
		HU: "HUF",
		RO: "RON",
		TR: "TRY",
		ZA: "ZAR",
		KR: "KRW",
		SG: "SGD",
		HK: "HKD",
		TW: "TWD",
		TH: "THB",
		ID: "IDR",
		MY: "MYR",
		PH: "PHP",
		VN: "VND",
		IL: "ILS",
		AE: "AED",
		SA: "SAR",
		EG: "EGP",
		NG: "NGN",
		UA: "UAH",
		IS: "ISK",
	};
	return currencies[region] ?? "XXX";
}

export function workbookDecimals(
	format: OsWorkbookCellFormat,
	context: WorkbookNumberContext = {},
): number {
	if (format.decimals !== undefined) return format.decimals;
	if (format.numberFormat === "integer") return 0;
	if (format.numberFormat === "scientific") return 4;
	if (format.numberFormat === "currency")
		return (
			new Intl.NumberFormat(context.locale, {
				style: "currency",
				currency: workbookCurrency(context),
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	return 2;
}

export function formatWorkbookNumber(
	cell: OsWorkbookCell | null,
	context: WorkbookNumberContext = {},
): string {
	const value = cell?.value ?? null;
	if (value === null) return "";
	const format = cell?.format?.numberFormat ?? "automatic";
	if (format === "text")
		return cell?.input.startsWith("=")
			? String(value)
			: (cell?.input ?? String(value));
	if (typeof value !== "number") return String(value);
	const decimals =
		cell?.format?.decimals ??
		(format === "number" || format === "percent" ? 2 : undefined);
	const digits =
		decimals === undefined
			? {}
			: { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
	if (format === "date" || format === "time" || format === "datetime") {
		return new Intl.DateTimeFormat(context.locale, {
			timeZone: "UTC",
			...(format !== "time"
				? ({ year: "numeric", month: "numeric", day: "numeric" } as const)
				: {}),
			...(format !== "date"
				? ({ hour: "numeric", minute: "2-digit", second: "2-digit" } as const)
				: {}),
		}).format(spreadsheetDate(value));
	}
	if (format === "scientific") return value.toExponential(decimals ?? 4);
	if (format === "automatic" && decimals === undefined) return String(value);
	return new Intl.NumberFormat(context.locale, {
		...(format === "currency"
			? ({ style: "currency", currency: workbookCurrency(context) } as const)
			: {}),
		...(format === "percent"
			? ({ style: "percent", maximumFractionDigits: 2 } as const)
			: {}),
		...digits,
		...(format === "integer"
			? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
			: {}),
	}).format(value);
}

function localizedNumberPattern(
	parts: Intl.NumberFormatPart[],
	pattern: string,
): string {
	let number = false;
	return parts
		.map((part) => {
			if (["integer", "group", "decimal", "fraction"].includes(part.type)) {
				if (number) return "";
				number = true;
				return pattern;
			}
			return part.type === "percentSign"
				? "%"
				: `"${part.value.replaceAll('"', "")}"`;
		})
		.join("");
}

export function workbookExcelNumberFormat(
	format: OsWorkbookCellFormat,
	context: WorkbookNumberContext = {},
): string {
	const decimals = workbookDecimals(format, context);
	const fraction = decimals ? `.${"0".repeat(decimals)}` : "";
	const timeFormat = new Intl.DateTimeFormat(context.locale, {
		hour: "numeric",
	}).resolvedOptions().hour12
		? "h:mm:ss AM/PM"
		: "hh:mm:ss";
	switch (format.numberFormat) {
		case "text":
			return "@";
		case "date": {
			const parts = new Intl.DateTimeFormat(context.locale, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				timeZone: "UTC",
			}).formatToParts(new Date(Date.UTC(2001, 10, 22)));
			return parts
				.map((p) =>
					p.type === "year"
						? "yyyy"
						: p.type === "month"
							? "mm"
							: p.type === "day"
								? "dd"
								: `"${p.value.replaceAll('"', "")}"`,
				)
				.join("");
		}
		case "time":
			return timeFormat;
		case "datetime":
			return `${workbookExcelNumberFormat({ numberFormat: "date" }, context)} ${timeFormat}`;
		case "currency": {
			const currency = workbookCurrency(context);
			const parts = new Intl.NumberFormat(context.locale, {
				style: "currency",
				currency,
			}).formatToParts(0);
			return localizedNumberPattern(parts, `#,##0${fraction}`);
		}
		case "percent":
			return localizedNumberPattern(
				new Intl.NumberFormat(context.locale, {
					style: "percent",
				}).formatToParts(0),
				`0${fraction}`,
			);
		case "scientific":
			return `0${fraction}E+00`;
		case "integer":
			return "#,##0";
		case "number":
			return `#,##0${fraction}`;
		default:
			return format.decimals === undefined ? "General" : `0${fraction}`;
	}
}
