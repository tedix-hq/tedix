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

export function normalizePortablePrefix(prefix?: string): string | null {
	const trimmed = prefix?.trim();
	if (!trimmed) return "";
	const directory = trimmed.endsWith("/");
	const path = normalizePortablePath(
		directory ? trimmed.slice(0, -1) : trimmed,
	);
	if (path === null) return null;
	const normalized = directory ? `${path}/` : path;
	return normalized.length <= 1024 ? normalized : null;
}
