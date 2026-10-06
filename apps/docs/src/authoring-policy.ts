export function assertDocsFilePath(value: string): string {
	const path = value.trim().replaceAll("\\", "/");
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\0") ||
		path.split("/").some((segment) => segment === ".." || segment === ".")
	) {
		throw new Error("Docs path must be a safe relative path");
	}
	if (!/\.(?:md|mdx)$/i.test(path)) {
		throw new Error("Git authoring currently supports Markdown and MDX files");
	}
	return path;
}
