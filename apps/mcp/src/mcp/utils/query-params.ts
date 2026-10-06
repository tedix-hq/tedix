import { isRecord } from "@tedix/api-contract/utils/is-record";

function scalarToString(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

export function appendQueryParam(
	params: URLSearchParams,
	key: string,
	value: unknown,
): void {
	if (value === undefined || value === null) return;

	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			const childKey = key.includes("[") ? `${key}[${index}]` : key;
			appendQueryParam(params, childKey, item);
		});
		return;
	}

	if (isRecord(value)) {
		for (const [childKey, childValue] of Object.entries(value)) {
			appendQueryParam(params, `${key}[${childKey}]`, childValue);
		}
		return;
	}

	params.append(key, scalarToString(value));
}

export function buildQueryString(
	input: Record<string, unknown>,
	arrayFormats: Record<string, "comma" | "space" | "pipe"> = {},
): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) {
		const format = arrayFormats[key];
		if (format && Array.isArray(value)) {
			const items = value.filter((item) => item !== undefined && item !== null);
			if (items.length)
				params.append(
					key,
					items
						.map(scalarToString)
						.join(format === "comma" ? "," : format === "space" ? " " : "|"),
				);
			continue;
		}
		appendQueryParam(params, key, value);
	}
	return params.toString();
}
