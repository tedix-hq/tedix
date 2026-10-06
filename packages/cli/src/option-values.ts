export function readNumberOption(
	name: string,
	value: string | undefined,
): number {
	// Fix #5: require a plain decimal integer string (no floats, hex, exponent,
	// leading-plus). The raw trimmed value must match /^\d+$/ before parsing.
	const raw = (value ?? "").trim();
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${name} must be a positive integer`);
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

export function readPositiveNumberOption(
	name: string,
	value: string | undefined,
): number {
	const raw = (value ?? "").trim();
	if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
		throw new Error(`${name} must be a positive number`);
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsed;
}

export function requireValue(flag: string, next: string | undefined): string {
	if (next === undefined || next.startsWith("-"))
		throw new Error(`${flag} requires a value`);
	return next;
}
