export function normalizePortablePath(path: unknown): string | null {
	if (typeof path !== "string") return null;
	const trimmed = path.trim().replace(/^\/+/, "");
	if (
		!trimmed ||
		trimmed.length > 1024 ||
		trimmed.includes("\0") ||
		trimmed.split("/").some((part) => !part || part === "." || part === "..")
	) {
		return null;
	}
	return trimmed;
}
