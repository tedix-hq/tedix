import {
	EDITABLE_DIRS,
	EDITABLE_FILES,
	lockedFilesForTemplate,
	lockedDirsForTemplate,
} from "../template-policy";

function normalizeThemePath(filePath: string): string | null {
	const normalized = filePath.replace(/^\/+/, "");
	const segments = normalized.split("/");
	if (
		!normalized ||
		segments.some(
			(segment) => segment.length === 0 || segment === "." || segment === "..",
		)
	) {
		return null;
	}
	return segments.join("/");
}

export function isPathEditable(
	filePath: string,
	templateSlug?: string | null,
): boolean {
	const normalized = normalizeThemePath(filePath);
	if (!normalized) return false;

	if (isPathLocked(normalized, templateSlug)) {
		return false;
	}

	return (
		(EDITABLE_FILES as readonly string[]).includes(normalized) ||
		EDITABLE_DIRS.some((dir) => normalized.startsWith(dir))
	);
}

export function isPathLocked(
	filePath: string,
	templateSlug?: string | null,
): boolean {
	const normalized = normalizeThemePath(filePath);
	if (!normalized) return false;
	return (
		lockedFilesForTemplate(templateSlug).includes(normalized) ||
		lockedDirsForTemplate(templateSlug).some((dir) =>
			normalized.startsWith(dir),
		)
	);
}
