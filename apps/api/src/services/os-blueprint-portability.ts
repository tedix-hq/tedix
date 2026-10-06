/**
 * Blueprint portability: the bounded export projection, the fork-lineage record
 * that survives an unreachable source organization, and the validation an
 * import performs BEFORE anything is persisted.
 *
 * Two rules this module exists to enforce:
 *
 * 1. EXPORT IS AN ALLOWLIST. `buildOsBlueprintExport` names every field it
 *    emits. It never spreads a row, so a column added to `os_blueprints` or
 *    `os_blueprint_revisions` later cannot silently start travelling. The
 *    exclusions are listed on `OsBlueprintExportSchema`.
 * 2. IMPORT VALIDATES, THEN PERSISTS THE PARSED OBJECT. The envelope is parsed
 *    by the contract, its digest is re-computed here against the definition it
 *    carries, and the caller writes `JSON.stringify(parsedDefinition)` — never
 *    the submitted bytes. Copying raw bytes across a tenant boundary is exactly
 *    how unvalidated publisher keys previously landed persisted in an importing
 *    organization's D1 while being invisible in the response.
 */

import {
	OS_BLUEPRINT_LINEAGE_DEPTH,
	OS_BLUEPRINT_EXPORT_ENVELOPE_VERSION,
	type OsBlueprintDefinition,
	type OsBlueprintExport,
	type OsBlueprintLineage,
	type OsBlueprintLineageEntry,
	OsBlueprintLineageSchema,
	type OsCreatedByKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OsBlueprintRevisionRow,
	OsBlueprintRow,
} from "@tedix/db/schema/os-workspaces";
import { canonicalDigest } from "../lib/blueprint-digest";

/**
 * Re-read a stored lineage chain. A row written before lineage existed has
 * none, and a chain that no longer parses is reported as absent rather than
 * reconstructed: provenance is audit evidence, so an invented partial chain
 * would be worse than a null.
 */
export function parseBlueprintLineage(
	value: string | null,
): OsBlueprintLineage | null {
	if (!value) return null;
	try {
		const parsed = OsBlueprintLineageSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Push one fork in front of the ancestry it inherited.
 *
 * `head` is the blueprint being forked FROM; `ancestry` is that blueprint's own
 * chain. The result is capped at {@link OS_BLUEPRINT_LINEAGE_DEPTH} entries with
 * the oldest dropped, and `truncated` stays true once anything has been dropped
 * anywhere in the history — a reader must never mistake a trimmed chain for a
 * complete one.
 */
export function buildForkLineage(
	head: OsBlueprintLineageEntry,
	ancestry: OsBlueprintLineage | null,
): OsBlueprintLineage {
	// Everything BEHIND the head is downgraded to unattested. A gallery fork
	// verifies its immediate source by reading those rows, but it cannot verify
	// what that source claims about ITS ancestors — and an envelope's whole
	// chain is caller-supplied. Propagating an inherited `attested: true` would
	// let one forged link launder the rest of the chain.
	const inherited = (ancestry?.chain ?? []).map((entry) => ({
		...entry,
		attested: false,
	}));
	const chain = [head, ...inherited];
	return {
		version: 1,
		chain: chain.slice(0, OS_BLUEPRINT_LINEAGE_DEPTH),
		truncated:
			chain.length > OS_BLUEPRINT_LINEAGE_DEPTH ||
			(ancestry?.truncated ?? false),
	};
}

export interface BuildOsBlueprintExportInput {
	blueprint: OsBlueprintRow;
	revision: OsBlueprintRevisionRow;
	/** The PARSED definition of that revision — never the stored bytes. */
	definition: OsBlueprintDefinition;
	/** Display name of the owning organization, recorded so the origin stays readable. */
	organizationName: string | null;
	exportedByKind: OsCreatedByKind;
	exportedAt: string;
}

/**
 * Project one blueprint revision into the portable envelope.
 *
 * `source.organizationId` is the single place tenant identity appears, and it is
 * there deliberately: it is the exporting organization's OWN id, and without it
 * a fork cannot name where it came from once the source is unreachable. No
 * principal id is emitted anywhere — only `createdByKind` / `exportedByKind`.
 */
export async function buildOsBlueprintExport(
	input: BuildOsBlueprintExportInput,
): Promise<OsBlueprintExport> {
	const definitionSha256 = await canonicalDigest(input.definition);
	return {
		envelopeVersion: OS_BLUEPRINT_EXPORT_ENVELOPE_VERSION,
		exportedAt: input.exportedAt,
		exportedByKind: input.exportedByKind,
		source: {
			organizationId: input.blueprint.organizationId,
			organizationName: input.organizationName,
			blueprintId: input.blueprint.id,
			blueprintName: input.blueprint.name,
			revisionId: input.revision.id,
			revision: input.revision.revision,
			definitionSha256,
			// True on the EXPORTING side, where the platform read these rows. The
			// importer overwrites it to false, because on the receiving side this
			// whole envelope is caller-supplied bytes.
			attested: true,
			forkedAt: input.exportedAt,
			via: "export",
		},
		blueprint: {
			name: input.blueprint.name,
			description: input.blueprint.description,
			status: input.blueprint.status,
		},
		revision: {
			revision: input.revision.revision,
			createdAt: input.revision.createdAt,
			publishedAt: input.revision.publishedAt,
			createdByKind: input.revision.createdByKind,
		},
		definition: input.definition,
		lineage: parseBlueprintLineage(input.blueprint.lineage),
	};
}

export type OsBlueprintExportVerification =
	| { ok: true; definitionSha256: string }
	| { ok: false; expected: string; actual: string };

/**
 * Verify that an envelope's recorded digest describes the definition it
 * actually carries. This is the check that makes the lineage digest mean
 * something: without it, an envelope could name an ancestor whose content it
 * does not contain.
 */
export async function verifyOsBlueprintExport(
	envelope: OsBlueprintExport,
): Promise<OsBlueprintExportVerification> {
	const actual = await canonicalDigest(envelope.definition);
	if (actual !== envelope.source.definitionSha256) {
		return { ok: false, expected: envelope.source.definitionSha256, actual };
	}
	return { ok: true, definitionSha256: actual };
}
