/** Direct-read command parsing, tool argument helpers and result extraction for the /read composer. */
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type {
	HomeReadOnlyApp,
	HomeMessage,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { osDirectReadApi } from "@/lib/api";

/** Connected-app discovery performs connection verification plus live MCP
 * inspection, so it shares the direct-read transport budget with execution. */
const osDirectReadQuery = createTanstackQueryUtils(osDirectReadApi);

export const readOnlyToolCatalogQueryOptions = (organizationId?: string) =>
	osDirectReadQuery.kernelRuntime.listReadOnlyTools.queryOptions({
		input: organizationId ? { organizationId } : {},
		staleTime: 30_000,
	});

export type DirectReadCommand = {
	appSlug: string;
	toolName: string;
	arguments: Record<string, unknown>;
};

export type DirectReadRequest = DirectReadCommand & {
	conversationId: string;
	idempotencyKey: string;
	organizationId?: string;
	workspaceContext?: {
		workspaceId: string;
		workpiece?: { kind: "gadget" | "output"; id: string };
	};
};

/** Parse only an explicit, fully-qualified direct-read command. Natural-language
 * requests remain Home turns and retain kernel/tedi governance. */
export function parseDirectReadCommand(
	content: string,
): DirectReadCommand | null {
	const match = content
		.trim()
		.match(
			/^\/read\s+([a-z0-9-]+)\.([a-zA-Z0-9_.-]+)(?:\s+(\{[\s\S]*\}))?\s*$/,
		);
	if (!match?.[1] || !match[2]) return null;
	let args: Record<string, unknown> = {};
	if (match[3]) {
		try {
			const parsed: unknown = JSON.parse(match[3]);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return null;
			args = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	return { appSlug: match[1], toolName: match[2], arguments: args };
}

type ReadTool = HomeReadOnlyApp["tools"][number];
type JsonSchemaField = {
	type?: string | string[];
	title?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
};

export function initialReadValues(
	tool: ReadTool | null,
): Record<string, string> {
	if (!tool) return {};
	return Object.fromEntries(
		readToolFields(tool).flatMap((field) => {
			if (field.schema.default === undefined) return [];
			const value = field.schema.default;
			return [
				[field.name, typeof value === "string" ? value : JSON.stringify(value)],
			];
		}),
	);
}

export function readConnectionLabel(
	state: HomeReadOnlyApp["connectionState"],
): string {
	return state === "connected"
		? "Connected"
		: state === "connection_required"
			? "Connect"
			: "Unavailable";
}

export function readToolFields(tool: ReadTool | null): Array<{
	name: string;
	required: boolean;
	schema: JsonSchemaField;
}> {
	if (!tool || !tool.inputSchema || typeof tool.inputSchema !== "object")
		return [];
	const root = tool.inputSchema as Record<string, unknown>;
	const properties = root.properties;
	if (
		!properties ||
		typeof properties !== "object" ||
		Array.isArray(properties)
	)
		return [];
	const required = new Set(
		Array.isArray(root.required)
			? root.required.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
	);
	return Object.entries(properties).flatMap(([name, value]) =>
		value && typeof value === "object" && !Array.isArray(value)
			? [
					{
						name,
						required: required.has(name),
						schema: value as JsonSchemaField,
					},
				]
			: [],
	);
}

function coerceReadArgument(raw: string, schema: JsonSchemaField): unknown {
	const type = Array.isArray(schema.type)
		? schema.type.find((value) => value !== "null")
		: schema.type;
	if (schema.enum) {
		const exactString = schema.enum.find(
			(value) => typeof value === "string" && value === raw,
		);
		if (exactString !== undefined) return exactString;
		const matchingValue = schema.enum.find((value) => String(value) === raw);
		if (matchingValue !== undefined) return matchingValue;
	}
	if (type === "number" || type === "integer") {
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) throw new Error("Enter a valid number");
		return parsed;
	}
	if (type === "boolean") return raw === "true";
	if (type === "object" || type === "array") return JSON.parse(raw);
	return raw;
}

export function buildReadArguments(
	tool: ReadTool,
	values: Record<string, string>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const field of readToolFields(tool)) {
		const raw = values[field.name]?.trim() ?? "";
		if (!raw) {
			if (field.required) throw new Error(`${field.name} is required`);
			continue;
		}
		try {
			output[field.name] = coerceReadArgument(raw, field.schema);
		} catch (error) {
			const types = Array.isArray(field.schema.type)
				? field.schema.type
				: [field.schema.type];
			if (types.includes("object") || types.includes("array")) {
				throw new Error(`${field.name} must be valid JSON`);
			}
			throw error;
		}
	}
	return output;
}

export function directReadResult(message: HomeMessage): unknown | null {
	const metadata = message.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		return null;
	const envelope = metadata as Record<string, unknown>;
	if (envelope.directReadResult !== undefined) return envelope.directReadResult;
	const nested = envelope.metadata;
	if (!nested || typeof nested !== "object" || Array.isArray(nested))
		return null;
	return (nested as Record<string, unknown>).directReadResult ?? null;
}

export function directReadError(message: HomeMessage): {
	kind: string;
	retryable: boolean;
	connectProviderId: string | null;
} | null {
	const metadata = message.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		return null;
	const envelope = metadata as Record<string, unknown>;
	const nested = envelope.metadata;
	const candidate =
		envelope.directReadError ??
		(nested && typeof nested === "object" && !Array.isArray(nested)
			? (nested as Record<string, unknown>).directReadError
			: undefined);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
		return null;
	const value = candidate as Record<string, unknown>;
	if (typeof value.kind !== "string") return null;
	return {
		kind: value.kind,
		retryable: value.retryable === true,
		connectProviderId:
			typeof value.connectProviderId === "string"
				? value.connectProviderId
				: null,
	};
}
