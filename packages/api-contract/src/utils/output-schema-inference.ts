import type { ToolJsonSchema } from "../schemas/tools";

export const INFERRED_SCHEMA_PROVENANCE = "x-tedix-provenance";

/** Shapes only: never retain sample values, enums, or examples. */
export function inferOutputSchema(
	sample: unknown,
	depth = 0,
	budget = { remaining: 1000 },
): ToolJsonSchema {
	if (depth >= 8 || --budget.remaining < 0) return {};
	if (sample === null) return { type: "null" };
	if (Array.isArray(sample)) {
		const items = sample
			.slice(0, 50)
			.map((value) => inferOutputSchema(value, depth + 1, budget));
		return {
			type: "array",
			items:
				items.reduce(
					mergeOutputSchemas,
					undefined as ToolJsonSchema | undefined,
				) ?? {},
		};
	}
	if (typeof sample === "object") {
		const entries = Object.entries(sample).slice(0, 100);
		return {
			type: "object",
			properties: Object.fromEntries(
				entries.map(([key, value]) => [
					key,
					inferOutputSchema(value, depth + 1, budget),
				]),
			),
			required: entries.map(([key]) => key),
		};
	}
	if (typeof sample === "string") return { type: "string" };
	if (typeof sample === "boolean") return { type: "boolean" };
	if (typeof sample === "number" && Number.isFinite(sample))
		return { type: "number" };
	return {};
}

export function mergeOutputSchemas(
	left: ToolJsonSchema | undefined,
	right: ToolJsonSchema,
): ToolJsonSchema {
	if (!left) return right;
	if (!Object.keys(left).length || !Object.keys(right).length) return {};
	if (left.type === "object" && right.type === "object") {
		const a = (left.properties ?? {}) as Record<string, ToolJsonSchema>;
		const b = (right.properties ?? {}) as Record<string, ToolJsonSchema>;
		return {
			type: "object",
			properties: Object.fromEntries(
				[...new Set([...Object.keys(a), ...Object.keys(b)])]
					.slice(0, 100)
					.map((key) => [
						key,
						a[key] && b[key]
							? mergeOutputSchemas(a[key], b[key]!)
							: (a[key] ?? b[key]!),
					]),
			),
			required: (left.required ?? []).filter((key) =>
				right.required?.includes(key),
			),
		};
	}
	if (left.type === "array" && right.type === "array") {
		return {
			type: "array",
			items: !Object.keys((left.items ?? {}) as object).length
				? (right.items ?? {})
				: !Object.keys((right.items ?? {}) as object).length
					? (left.items ?? {})
					: mergeOutputSchemas(
							left.items as ToolJsonSchema,
							right.items as ToolJsonSchema,
						),
		};
	}
	if (JSON.stringify(left) === JSON.stringify(right)) return right;
	const variants = [
		...(Array.isArray(left.anyOf) ? left.anyOf : [left]),
		...(Array.isArray(right.anyOf) ? right.anyOf : [right]),
	];
	if (variants.length > 8) return {};
	return {
		anyOf: [
			...new Map(
				variants.map((schema) => [JSON.stringify(schema), schema]),
			).values(),
		],
	};
}
