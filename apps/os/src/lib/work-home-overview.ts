export function workHomeMattersThrough(now: Date): string {
	const through = new Date(now);
	through.setDate(through.getDate() + 7);
	through.setHours(23, 59, 59, 999);
	return through.toISOString();
}
