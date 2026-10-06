export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

export function asItems<T>(value: T[] | null | undefined): T[] {
	return Array.isArray(value) ? value : [];
}
