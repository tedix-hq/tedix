/** A small, deterministic predicate language for owner-authored tool rules. */
export type TenantPolicyPredicate = { version: 1; schema: TenantPolicyNode };

type Scalar = string | boolean | number | null;
export type TenantPolicyNode =
	| { anyOf: TenantPolicyNode[] }
	| {
			type: "object";
			properties: Record<string, TenantPolicyNode>;
			required?: string[];
			additionalProperties: boolean;
	  }
	| {
			type: "array";
			items: TenantPolicyNode;
			minItems?: number;
			maxItems?: number;
	  }
	| {
			type: "string";
			minLength?: number;
			nonBlank?: boolean;
			const?: string;
			enum?: string[];
	  }
	| { type: "boolean"; const?: boolean; enum?: boolean[] }
	| { type: "number"; const?: number; enum?: number[] }
	| { type: "null"; const?: null; enum?: null[] };

const MAX_DEPTH = 12;
const MAX_SCHEMA_NODES = 256;
const MAX_VALUE_NODES = 20_000;
const MAX_BRANCHES = 32;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function scalarMatchesType(value: unknown, type: string): value is Scalar {
	return type === "null"
		? value === null
		: typeof value === type && (type !== "number" || Number.isFinite(value));
}

/** Reject unknown operators and oversized or ambiguous rules before use. */
export function isTenantPolicyPredicate(
	value: unknown,
): value is TenantPolicyPredicate {
	if (
		!record(value) ||
		!exactKeys(value, ["version", "schema"]) ||
		value.version !== 1
	)
		return false;
	let nodes = 0;
	const visit = (node: unknown, depth: number): boolean => {
		if (++nodes > MAX_SCHEMA_NODES || depth > MAX_DEPTH || !record(node))
			return false;
		if (Object.hasOwn(node, "anyOf")) {
			return (
				exactKeys(node, ["anyOf"]) &&
				Array.isArray(node.anyOf) &&
				node.anyOf.length > 0 &&
				node.anyOf.length <= MAX_BRANCHES &&
				node.anyOf.every((child) => visit(child, depth + 1))
			);
		}
		if (node.type === "object") {
			if (
				!exactKeys(node, [
					"type",
					"properties",
					"required",
					"additionalProperties",
				]) ||
				!record(node.properties) ||
				typeof node.additionalProperties !== "boolean"
			)
				return false;
			const entries = Object.entries(node.properties);
			if (
				entries.length > MAX_BRANCHES ||
				entries.some(([key, child]) => !key || !visit(child, depth + 1))
			)
				return false;
			return (
				node.required === undefined ||
				(Array.isArray(node.required) &&
					node.required.length <= MAX_BRANCHES &&
					node.required.every(
						(key) =>
							typeof key === "string" &&
							Object.hasOwn(node.properties as object, key),
					) &&
					new Set(node.required).size === node.required.length)
			);
		}
		if (node.type === "array") {
			if (
				!exactKeys(node, ["type", "items", "minItems", "maxItems"]) ||
				!visit(node.items, depth + 1)
			)
				return false;
			const validCount = (v: unknown) =>
				v === undefined ||
				(Number.isInteger(v) &&
					(v as number) >= 0 &&
					(v as number) <= MAX_VALUE_NODES);
			return (
				validCount(node.minItems) &&
				validCount(node.maxItems) &&
				(node.minItems === undefined ||
					node.maxItems === undefined ||
					(node.minItems as number) <= (node.maxItems as number))
			);
		}
		if (!["string", "number", "boolean", "null"].includes(String(node.type)))
			return false;
		const keys =
			node.type === "string"
				? ["type", "const", "enum", "minLength", "nonBlank"]
				: ["type", "const", "enum"];
		if (!exactKeys(node, keys)) return false;
		if (
			Object.hasOwn(node, "const") &&
			!scalarMatchesType(node.const, node.type as string)
		)
			return false;
		if (
			node.enum !== undefined &&
			(!Array.isArray(node.enum) ||
				node.enum.length === 0 ||
				node.enum.length > MAX_BRANCHES ||
				!node.enum.every((item) =>
					scalarMatchesType(item, node.type as string),
				))
		)
			return false;
		if (
			node.minLength !== undefined &&
			(!Number.isInteger(node.minLength) ||
				(node.minLength as number) < 0 ||
				(node.minLength as number) > MAX_VALUE_NODES)
		)
			return false;
		return node.nonBlank === undefined || typeof node.nonBlank === "boolean";
	};
	return visit(value.schema, 0);
}

export type TenantPolicyEvaluationBudget = { remaining: number };

/** Share one budget across every rule in a policy set. */
export function createTenantPolicyEvaluationBudget(): TenantPolicyEvaluationBudget {
	return { remaining: MAX_VALUE_NODES };
}

/** Invalid and exhausted evaluations must never be mistaken for nonmatches. */
export function evaluateTenantPolicyPredicate(
	predicate: unknown,
	value: unknown,
	budget: TenantPolicyEvaluationBudget = createTenantPolicyEvaluationBudget(),
): "match" | "no_match" | "invalid" {
	if (
		!isTenantPolicyPredicate(predicate) ||
		!Number.isSafeInteger(budget.remaining) ||
		budget.remaining < 0
	)
		return "invalid";
	let exhausted = false;
	const match = (
		node: TenantPolicyNode,
		current: unknown,
		depth: number,
	): boolean => {
		if (--budget.remaining < 0 || depth > MAX_DEPTH) {
			exhausted = true;
			return false;
		}
		if ("anyOf" in node)
			return node.anyOf.some((child) => match(child, current, depth + 1));
		if (node.type === "object") {
			if (!record(current)) return false;
			if (node.required?.some((key) => !Object.hasOwn(current, key)))
				return false;
			const entries = Object.entries(current);
			if (entries.length > budget.remaining) {
				exhausted = true;
				return false;
			}
			budget.remaining -= entries.length;
			return entries.every(([key, child]) => {
				const property = Object.hasOwn(node.properties, key)
					? node.properties[key]
					: undefined;
				return property
					? match(property, child, depth + 1)
					: node.additionalProperties;
			});
		}
		if (node.type === "array")
			return (
				Array.isArray(current) &&
				(node.minItems === undefined || current.length >= node.minItems) &&
				(node.maxItems === undefined || current.length <= node.maxItems) &&
				current.every((item) => match(node.items, item, depth + 1))
			);
		if (!scalarMatchesType(current, node.type)) return false;
		if ("const" in node && current !== node.const) return false;
		if (node.enum && !(node.enum as Scalar[]).includes(current)) return false;
		if (node.type === "string")
			return (
				typeof current === "string" &&
				(node.minLength === undefined || current.length >= node.minLength) &&
				(!node.nonBlank || current.trim().length > 0)
			);
		return true;
	};
	const result = match(predicate.schema, value, 0);
	return exhausted ? "invalid" : result ? "match" : "no_match";
}

/** Convenience for uses that treat an invalid predicate as a denial. */
export function matchesTenantPolicyPredicate(
	predicate: unknown,
	value: unknown,
): boolean {
	return evaluateTenantPolicyPredicate(predicate, value) === "match";
}
