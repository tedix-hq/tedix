import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import { errorText } from "./format";
import type { TedixHomeClient } from "./home-client";

export type GatewayProjectionClient = Pick<TedixHomeClient, "runCode">;

/** Run one fixed, read-only gateway callable and reject clipped/error values. */
export async function readGatewayProjection(
	client: GatewayProjectionClient,
	callable: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const raw = await client.runCode(
		`async () => await ${callable}(${JSON.stringify(input)})`,
	);
	const normalized = normalizeCodeResult(raw);
	if (normalized.truncated) throw new Error(truncationErrorMessage(normalized));
	const value = normalized.value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.ok === false) {
			throw new Error(
				errorText(
					record.error ?? record.message ?? "gateway rejected the call",
				),
			);
		}
		if (
			typeof record.code === "string" &&
			(record.defined === true ||
				(typeof record.status === "number" && record.status >= 400))
		) {
			throw new Error(errorText(record.message ?? record.code));
		}
	}
	return value;
}

export function rowsFrom(
	value: unknown,
	...keys: string[]
): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (Array.isArray(record[key])) {
			return record[key] as Array<Record<string, unknown>>;
		}
	}
	return [];
}
