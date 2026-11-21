import {
	TaskReturnedValueSchema,
	type TaskContractTerms,
} from "../schemas/task-contract-terms";

export function assertChildTaskContract(
	parent: TaskContractTerms,
	child: TaskContractTerms,
): void {
	if (
		parent.remainingDepth === 0 ||
		child.remainingDepth >= parent.remainingDepth
	)
		throw new Error("Task delegation depth exhausted");
	if (
		child.budget.maxTokens > parent.budget.maxTokens ||
		child.budget.maxCostUsd > parent.budget.maxCostUsd
	)
		throw new Error("Child task budget exceeds parent contract");
	if (
		child.errorAllowance > parent.errorAllowance ||
		Date.parse(child.deadline) > Date.parse(parent.deadline)
	)
		throw new Error("Child task exceeds parent error allowance or deadline");
}

export function validateTaskReturnedValue(
	contract: TaskContractTerms,
	rawResult: unknown,
): void {
	const result = TaskReturnedValueSchema.parse(rawResult);
	if (
		result.usage.tokens > contract.budget.maxTokens ||
		result.usage.costUsd > contract.budget.maxCostUsd
	)
		throw new Error("Task result exceeds budget");
	if (result.errors > contract.errorAllowance)
		throw new Error("Task error allowance exceeded");
	const output = result.output;
	if (output === null || typeof output !== "object" || Array.isArray(output))
		throw new Error("Task return format requires an object");
	const format = contract.returnFormat;
	if (format.required.some((key) => !Object.hasOwn(output, key)))
		throw new Error("Task return format is missing a required field");
	for (const [key, value] of Object.entries(output)) {
		const field = Object.hasOwn(format.properties, key)
			? format.properties[key]
			: undefined;
		const type =
			value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		if (!field || field.type !== type)
			throw new Error("Task return format mismatch");
	}
	for (const check of contract.successCriterion) {
		let value: unknown = output;
		for (const key of check.path) {
			if (
				value === null ||
				typeof value !== "object" ||
				!Object.hasOwn(value, key)
			) {
				value = undefined;
				break;
			}
			value = (value as Record<string | number, unknown>)[key];
		}
		if (!equalJson(value, check.equals))
			throw new Error("Task success criterion failed");
	}
}

function equalJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		!a ||
		!b ||
		typeof a !== "object" ||
		typeof b !== "object" ||
		Array.isArray(a) !== Array.isArray(b)
	)
		return false;
	const left = Object.keys(a);
	const right = Object.keys(b);
	return (
		left.length === right.length &&
		left.every(
			(key) =>
				Object.hasOwn(b, key) &&
				equalJson(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				),
		)
	);
}
