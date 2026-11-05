import type { ToolJsonSchema } from "@tedix/api-contract/schemas/tools";

const FIELD_SELECTION_SCHEMA = {
	type: "array",
	items: { type: "string", minLength: 1 },
	description:
		"Reserved runtime argument: return only these dotted response paths (for example data.id and data.title). Arrays retain their structure; missing paths are omitted. Applied before result limits and storage. An empty array selects no fields.",
} as const;

export function withFieldSelectionSchema(
	schema: ToolJsonSchema,
): ToolJsonSchema {
	return {
		...schema,
		properties: { ...schema.properties, _fields: FIELD_SELECTION_SCHEMA },
	};
}

export function readResponseFields(
	input: Record<string, unknown>,
): string[] | undefined {
	if (!Object.hasOwn(input, "_fields")) return undefined;
	const fields = input._fields;
	if (
		!Array.isArray(fields) ||
		fields.some(
			(path) =>
				typeof path !== "string" ||
				path
					.split(".")
					.some(
						(part) =>
							!part || ["__proto__", "constructor", "prototype"].includes(part),
					),
		)
	) {
		throw new Error(
			"_fields must be an array of non-empty dotted response paths without prototype keys",
		);
	}
	return fields;
}

interface Selection {
	whole: boolean;
	children: Map<string, Selection>;
}

export function selectResponseFields(value: unknown, paths: string[]): unknown {
	const root: Selection = { whole: false, children: new Map() };
	for (const path of paths) {
		let node = root;
		for (const key of path.split(".")) {
			if (!node.children.has(key))
				node.children.set(key, { whole: false, children: new Map() });
			node = node.children.get(key)!;
		}
		node.whole = true;
	}
	const project = (input: unknown, node: Selection): unknown => {
		if (node.whole) return input;
		if (Array.isArray(input))
			return input.map((item) => project(item, node) ?? {});
		const output: Record<string, unknown> = {};
		if (input !== null && typeof input === "object") {
			for (const [key, child] of node.children) {
				if (!Object.hasOwn(input, key)) continue;
				const selected = project(
					(input as Record<string, unknown>)[key],
					child,
				);
				if (selected !== undefined)
					Object.defineProperty(output, key, {
						value: selected,
						enumerable: true,
						configurable: true,
						writable: true,
					});
			}
		}
		return Object.keys(output).length ? output : undefined;
	};
	return project(value, root) ?? {};
}

// SDK output validation still checks the complete result, already checked by
// executeTool before selection. Weak keys keep the original request-local.
export const fieldSelectionSources = new WeakMap<object, unknown>();

export function readFieldSelectionMetrics(result: unknown): {
	responseBytesBefore?: number;
	responseBytesAfter?: number;
} {
	const metrics = (result as { _meta?: Record<string, unknown> } | null)
		?._meta?.["tedix/fieldSelection"] as Record<string, unknown> | undefined;
	return metrics &&
		typeof metrics.responseBytesBefore === "number" &&
		typeof metrics.responseBytesAfter === "number"
		? {
				responseBytesBefore: metrics.responseBytesBefore,
				responseBytesAfter: metrics.responseBytesAfter,
			}
		: {};
}
