import {
	PortableTediManifestSchema,
	PortableTediDomainSchema,
	PortableTediEdgeSchema,
	PortableTediFactSchema,
	PortableTediRationaleSchema,
	PortableTediSkillSchema,
	type PortableTediManifest,
} from "../schemas/portable-tedi";
import type * as z from "zod";

export type PortableTediSnapshotFiles = Readonly<Record<string, Uint8Array>>;

export type PortableTediImportGraph = {
	memoryDomains: ReadonlyArray<{ id: string; parentId?: string | null }>;
	memoryFacts: ReadonlyArray<{
		id: string;
		domainId?: string | null;
		promotedFrom?: string | null;
	}>;
	memoryEdges: ReadonlyArray<{
		id: string;
		sourceFactId: string;
		targetFactId: string;
	}>;
	skills: ReadonlyArray<{
		id: string;
		domainId?: string | null;
		sourceSkillId?: string | null;
		supersedesId?: string | null;
	}>;
	rationale: ReadonlyArray<{ id: string }>;
};

/** Reject dangling links before the destination receives any rows. */
export function validatePortableTediImportGraph(
	rows: PortableTediImportGraph,
): void {
	function ids(section: keyof PortableTediImportGraph): Set<string> {
		const set = new Set<string>();
		for (const row of rows[section]) {
			if (set.has(row.id)) throw new Error(`Duplicate portable ${section} ID`);
			set.add(row.id);
		}
		return set;
	}
	const domains = ids("memoryDomains");
	const facts = ids("memoryFacts");
	ids("memoryEdges");
	const skills = ids("skills");
	ids("rationale");
	function requireLink(
		value: string | null | undefined,
		set: Set<string>,
		label: string,
	) {
		if (value && !set.has(value)) {
			throw new Error(`Portable ${label} points outside the snapshot`);
		}
	}
	for (const row of rows.memoryDomains) {
		requireLink(row.parentId, domains, "domain parent");
	}
	for (const row of rows.memoryFacts) {
		requireLink(row.domainId, domains, "fact domain");
		requireLink(row.promotedFrom, facts, "fact promotion");
	}
	for (const row of rows.memoryEdges) {
		requireLink(row.sourceFactId, facts, "edge source");
		requireLink(row.targetFactId, facts, "edge target");
	}
	for (const row of rows.skills) {
		requireLink(row.domainId, domains, "skill domain");
		requireLink(row.sourceSkillId, skills, "source skill");
		requireLink(row.supersedesId, skills, "superseded skill");
	}
}

/** Stable destination UUIDs make page retries idempotent without source IDs. */
export async function portableTediDestinationId(
	destinationTediId: string,
	section: keyof PortableTediImportGraph,
	sourceId: string,
): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`tedix-portable-v1\0${destinationTediId}\0${section}\0${sourceId}`,
			),
		),
	).slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validate section shapes and links only after byte and credential checks pass. */
export async function parsePortableTediImportSnapshot(
	input: unknown,
	files: PortableTediSnapshotFiles,
) {
	const manifest = await verifyPortableTediSnapshotFiles(input, files);
	function readRows<T>(path: string, schema: z.ZodType<T>): T[] {
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(files[path]);
		if (!text) return [];
		return text
			.trimEnd()
			.split("\n")
			.map((line) => schema.parse(JSON.parse(line)));
	}
	const rows = {
		memoryDomains: readRows(
			manifest.files.memoryDomains.path,
			PortableTediDomainSchema,
		),
		memoryFacts: readRows(
			manifest.files.memoryFacts.path,
			PortableTediFactSchema,
		),
		memoryEdges: readRows(
			manifest.files.memoryEdges.path,
			PortableTediEdgeSchema,
		),
		skills: readRows(manifest.files.skills.path, PortableTediSkillSchema),
		rationale: readRows(
			manifest.files.rationale.path,
			PortableTediRationaleSchema,
		),
	};
	validatePortableTediImportGraph(rows);
	return { manifest, rows };
}

const CREDENTIAL_FIELD =
	/^(?:password|passphrase|secret|client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|token)$/i;
const CREDENTIAL_VALUE =
	/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b(?:sk_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_-]{24,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/;

function rejectCredentialFields(value: unknown, path: string): void {
	if (typeof value === "string") {
		if (CREDENTIAL_VALUE.test(value)) {
			throw new Error(`Credential-shaped content in portable tedi: ${path}`);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectCredentialFields(item, `${path}[${index}]`);
		}
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, item] of Object.entries(value)) {
		const childPath = `${path}.${key}`;
		if (CREDENTIAL_FIELD.test(key) && typeof item === "string" && item.trim()) {
			throw new Error(`Credential field in portable tedi: ${childPath}`);
		}
		rejectCredentialFields(item, childPath);
	}
}

/**
 * Check the bytes named by the manifest before an importer creates any state.
 * Record-level validation and identity rebinding happen after this byte check.
 */
export async function verifyPortableTediSnapshotFiles(
	input: unknown,
	files: PortableTediSnapshotFiles,
): Promise<PortableTediManifest> {
	const manifest = verifyPortableTediManifest(input);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const expectedPaths = new Set(
		Object.values(manifest.files).map((entry) => entry.path),
	);
	for (const path of Object.keys(files)) {
		if (path.startsWith("snapshot/") && !expectedPaths.has(path)) {
			throw new Error(`Unlisted portable tedi snapshot: ${path}`);
		}
	}

	for (const [section, entry] of Object.entries(manifest.files)) {
		const bytes = files[entry.path];
		if (!bytes) throw new Error(`Missing portable tedi snapshot: ${section}`);
		const hash = new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
		);
		const digest = Array.from(hash, (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
		if (digest !== entry.sha256) {
			throw new Error(`Portable tedi snapshot digest mismatch: ${section}`);
		}

		const text = decoder.decode(bytes);
		const lines = text.endsWith("\n")
			? text.slice(0, -1).split("\n")
			: text.split("\n");
		const count = text.length === 0 ? 0 : lines.length;
		if (count !== entry.count) {
			throw new Error(`Portable tedi snapshot row count mismatch: ${section}`);
		}
		for (const [index, line] of lines.entries()) {
			if (count === 0) break;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new Error(
					`Invalid portable tedi JSON: ${section} row ${index + 1}`,
				);
			}
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				throw new Error(
					`Portable tedi row must be an object: ${section} row ${index + 1}`,
				);
			}
			rejectCredentialFields(parsed, `${section}[${index + 1}]`);
		}
	}
	return manifest;
}

export function verifyPortableTediManifest(
	input: unknown,
): PortableTediManifest {
	const manifest = PortableTediManifestSchema.parse(input);
	rejectCredentialFields(manifest, "manifest");
	return manifest;
}
