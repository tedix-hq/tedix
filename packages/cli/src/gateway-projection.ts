import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import { errorText } from "./format";
import type { TedixHomeClient } from "./home-client";

export type GatewayProjectionClient = Pick<TedixHomeClient, "runCode">;

/**
 * Run one fixed, read-only gateway callable and reject clipped/error values.
 * `rowFields` keeps only those fields of each `data` row inside the sandbox,
 * so a long list fits under the gateway's result cap.
 */
export async function readGatewayProjection(
	client: GatewayProjectionClient,
	callable: string,
	input: Record<string, unknown>,
	rowFields?: readonly string[],
	rowKey = "data",
): Promise<unknown> {
	const call = `await ${callable}(${JSON.stringify(input)})`;
	const key = JSON.stringify(rowKey);
	let raw: unknown;
	try {
		raw = await client.runCode(
			rowFields
				? `async () => { const r = ${call}; const keys = ${JSON.stringify(rowFields)}; return Array.isArray(r?.[${key}]) ? { ...r, [${key}]: r[${key}].map((row) => Object.fromEntries(keys.map((k) => [k, row?.[k]]))) } : r; }`
				: `async () => ${call}`,
		);
	} catch (error) {
		const message = errorText(error);
		const inner = innerToolError(message);
		throw inner === message ? error : new Error(inner);
	}
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

/** The Code Mode envelope inside an "MCP tool error: {...}" message, if any. */
export function toolErrorEnvelope(message: string): unknown {
	const json = /MCP tool error:\s*(\{[\s\S]*\})\s*$/.exec(message)?.[1];
	if (!json) return undefined;
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}

/**
 * A failed call comes back as "MCP tool error: <Code Mode envelope JSON>";
 * keep only the failed tool's own error, unwrapping nested envelopes.
 */
export function innerToolError(message: string): string {
	const envelope = toolErrorEnvelope(message);
	if (envelope === undefined) return message;
	const [failure] = normalizeCodeResult(envelope).failures ?? [];
	if (!failure?.error) return message;
	const inner = innerToolError(failure.error);
	return inner === failure.error
		? `${failure.tool}: ${errorText(inner)}`
		: inner;
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
