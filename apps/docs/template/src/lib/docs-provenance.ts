import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const COMMIT_RE = /^[a-f0-9]{40,64}$/i;
const ISO_DATE_TIME_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const CONTENT_DIR = resolve("src/content/docs");
const MANIFEST_PATH = resolve(".tedix/docs-provenance.json");

interface ProvenancePage {
	commit: string;
	updatedAt: string;
}

export interface DocsProvenance {
	sourceRevision: string;
	pages: ReadonlyMap<string, ProvenancePage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafePagePath(value: string): boolean {
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		!/^.+\.mdx?$/i.test(value)
	) {
		return false;
	}
	return value
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isIsoDateTime(value: string): boolean {
	const match = ISO_DATE_TIME_RE.exec(value);
	if (!match) return false;
	const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
		match;
	if (!year || !month || !day || !hour || !minute || !second) return false;
	const yearNumber = Number(year);
	const monthNumber = Number(month);
	const dayNumber = Number(day);
	const daysInMonth = new Date(
		Date.UTC(yearNumber, monthNumber, 0),
	).getUTCDate();
	return (
		monthNumber >= 1 &&
		monthNumber <= 12 &&
		dayNumber >= 1 &&
		dayNumber <= daysInMonth &&
		Number(hour) <= 23 &&
		Number(minute) <= 59 &&
		Number(second) <= 59 &&
		(offsetHour === undefined ||
			(Number(offsetHour) <= 23 && Number(offsetMinute) <= 59)) &&
		Number.isFinite(Date.parse(value))
	);
}

/**
 * Validate a provenance snapshot as one atomic claim. Partial or malformed
 * snapshots are ignored so a stale export cannot label only some current pages.
 */
export function validateDocsProvenance(
	value: unknown,
	stagedPagePaths: readonly string[],
): DocsProvenance | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sourceRevision !== "string" ||
		!COMMIT_RE.test(value.sourceRevision) ||
		!isRecord(value.pages)
	) {
		return undefined;
	}

	const pages = new Map<string, ProvenancePage>();
	for (const [path, rawPage] of Object.entries(value.pages)) {
		if (
			!isSafePagePath(path) ||
			!isRecord(rawPage) ||
			typeof rawPage.commit !== "string" ||
			!COMMIT_RE.test(rawPage.commit) ||
			typeof rawPage.updatedAt !== "string" ||
			!isIsoDateTime(rawPage.updatedAt)
		) {
			return undefined;
		}
		pages.set(path, {
			commit: rawPage.commit,
			updatedAt: rawPage.updatedAt,
		});
	}

	for (const path of stagedPagePaths) {
		if (!pages.has(path)) return undefined;
	}
	return { sourceRevision: value.sourceRevision, pages };
}

async function listStagedPages(
	directory = CONTENT_DIR,
	prefix = "",
): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const pagePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			paths.push(
				...(await listStagedPages(resolve(directory, entry.name), pagePath)),
			);
		} else if (
			entry.isFile() &&
			/\.mdx?$/i.test(entry.name) &&
			entry.name !== "SKILL.md"
		) {
			paths.push(pagePath);
		}
	}
	return paths.sort();
}

export async function loadDocsProvenance(options?: {
	contentDir?: string;
	manifestPath?: string;
}): Promise<DocsProvenance | undefined> {
	try {
		const contentDir = options?.contentDir ?? CONTENT_DIR;
		const manifestPath = options?.manifestPath ?? MANIFEST_PATH;
		const [source, stagedPagePaths] = await Promise.all([
			readFile(manifestPath, "utf8"),
			listStagedPages(contentDir),
		]);
		return validateDocsProvenance(
			JSON.parse(source),
			process.env.TEDIX_DOCS_SYNTHETIC_ENTRY === "true"
				? stagedPagePaths.filter((path) => path !== "index.mdx")
				: stagedPagePaths,
		);
	} catch {
		return undefined;
	}
}

let provenancePromise: Promise<DocsProvenance | undefined> | undefined;

export async function getProvenanceLastUpdated(entry: {
	filePath?: string;
}): Promise<Date | undefined> {
	if (!entry.filePath) return undefined;
	const relativePath = relative(CONTENT_DIR, entry.filePath)
		.split(sep)
		.join("/");
	if (!isSafePagePath(relativePath)) return undefined;
	provenancePromise ??= loadDocsProvenance();
	const updatedAt = (await provenancePromise)?.pages.get(
		relativePath,
	)?.updatedAt;
	return updatedAt ? new Date(updatedAt) : undefined;
}
