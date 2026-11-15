import type * as z from "zod";

type Issue = z.core.$ZodIssue;
type UnknownKeys = { path: PropertyKey[]; keys: string[] };

/**
 * The unknown keys to drop so the schema can be tried again. A union branch is
 * followed only when unknown keys are its sole complaint; of several such
 * branches the one that drops the fewest keys wins.
 */
function unknownKeys(issues: Issue[], base: PropertyKey[] = []): UnknownKeys[] {
	const found: UnknownKeys[] = [];
	for (const issue of issues) {
		const path = [...base, ...issue.path];
		if (issue.code === "unrecognized_keys")
			found.push({ path, keys: issue.keys });
		else if (issue.code === "invalid_union") {
			const branches = issue.errors
				.filter((branch) => branch.length > 0 && onlyUnknownKeys(branch))
				.map((branch) => unknownKeys(branch, path))
				.sort((a, b) => keyCount(a) - keyCount(b));
			if (branches[0]) found.push(...branches[0]);
		}
	}
	return found;
}

function onlyUnknownKeys(issues: Issue[]): boolean {
	return issues.every(
		(issue) =>
			issue.code === "unrecognized_keys" ||
			(issue.code === "invalid_union" &&
				issue.errors.some(
					(branch) => branch.length > 0 && onlyUnknownKeys(branch),
				)),
	);
}

function keyCount(found: UnknownKeys[]): number {
	return found.reduce((total, entry) => total + entry.keys.length, 0);
}

function at(value: unknown, path: PropertyKey[]): unknown {
	return path.reduce<unknown>(
		(current, key) =>
			typeof current === "object" && current !== null
				? (current as Record<PropertyKey, unknown>)[key]
				: undefined,
		value,
	);
}

function describe(issues: Issue[], value: unknown): string {
	return issues
		.map((issue) => {
			const path = issue.path.join(".");
			if (
				issue.code === "invalid_type" &&
				path &&
				at(value, issue.path) === undefined
			)
				return `${path} is missing`;
			return `${path || "response"}: ${issue.message}`;
		})
		.join("; ");
}

/**
 * Check a server response against a schema this CLI carries, ignoring fields
 * the schema does not know.
 *
 * Tedix Cloud deploys ahead of CLI releases, so a response may carry fields
 * added after this CLI was built. Those are dropped, at any depth, even where
 * the schema is strict. Every field the schema declares is still checked: a
 * missing or retyped one fails and is named in `message`.
 */
export function safeParseServerResponse<S extends z.ZodType>(
	schema: S,
	value: unknown,
): { success: true; data: z.output<S> } | { success: false; message: string } {
	let current = value;
	for (;;) {
		const result = schema.safeParse(current);
		if (result.success) return { success: true, data: result.data };
		const drop = unknownKeys(result.error.issues);
		if (current === value && drop.length > 0) current = structuredClone(value);
		let dropped = 0;
		for (const { path, keys } of drop) {
			const holder = at(current, path);
			if (typeof holder !== "object" || holder === null) continue;
			for (const key of keys)
				if (key in holder) {
					delete (holder as Record<string, unknown>)[key];
					dropped++;
				}
		}
		if (dropped === 0)
			return {
				success: false,
				message: describe(result.error.issues, current),
			};
	}
}

/** {@link safeParseServerResponse}, throwing an error that names the fields and the fix. */
export function parseServerResponse<S extends z.ZodType>(
	schema: S,
	value: unknown,
	what: string,
): z.output<S> {
	const result = safeParseServerResponse(schema, value);
	if (result.success) return result.data;
	throw new Error(
		`${what} is not what this CLI expects: ${result.message}. The server may be newer than this CLI; run \`tedix update\` and retry.`,
	);
}
