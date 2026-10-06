export function isSupportedCatalogR2Path(path: string): boolean {
	return path === "catalog/claude" || path.startsWith("catalog/claude/");
}
