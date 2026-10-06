/**
 * The portable export projection and the fork-lineage record.
 *
 * The load-bearing property is that the envelope is an ALLOWLIST: it is built
 * field by field from the row, so a column added to `os_blueprints` or
 * `os_blueprint_revisions` later cannot start travelling on its own. The first
 * test pins the exact key set for that reason — it is meant to fail when someone
 * adds a field, so the addition is a decision rather than a side effect.
 */

import type { OsBlueprintDefinition } from "@tedix/api-contract/schemas/os-workspaces";
import { OsBlueprintExportSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OsBlueprintRevisionRow,
	OsBlueprintRow,
} from "@tedix/db/schema/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { canonicalDigest, canonicalJson } from "../lib/blueprint-digest";
import {
	buildForkLineage,
	buildOsBlueprintExport,
	parseBlueprintLineage,
	verifyOsBlueprintExport,
} from "./os-blueprint-portability";

const SOURCE_BLUEPRINT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SOURCE_REVISION_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/**
 * Every field mirrors its producer exactly: `os_blueprints` and
 * `os_blueprint_revisions` (packages/db/src/schema/os-workspaces.ts).
 */
function blueprintRow(overrides: Partial<OsBlueprintRow> = {}): OsBlueprintRow {
	return {
		id: SOURCE_BLUEPRINT_ID,
		organizationId: "org-source",
		name: "Sales Pod",
		description: "Shared sales pod",
		status: "published",
		visibility: "catalog",
		currentRevisionId: SOURCE_REVISION_ID,
		lineage: null,
		createdByKind: "user",
		createdById: "descope-sub-of-the-author",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
		...overrides,
	};
}

function revisionRow(
	overrides: Partial<OsBlueprintRevisionRow> = {},
): OsBlueprintRevisionRow {
	return {
		id: SOURCE_REVISION_ID,
		organizationId: "org-source",
		blueprintId: SOURCE_BLUEPRINT_ID,
		revision: 3,
		definition: JSON.stringify(definition()),
		createdByKind: "tedi",
		createdById: "tedi-id-of-the-author",
		createdAt: "2026-08-02T00:00:00.000Z",
		publishedAt: "2026-08-02T01:00:00.000Z",
		...overrides,
	};
}

function definition(): OsBlueprintDefinition {
	return {
		gadgets: [
			{
				name: "CRM",
				manifest: { entry: "crm.ts", capabilities: ["email:read"] },
			},
		],
		requirements: {
			version: 1,
			skills: [],
			connections: [
				{ providerId: "gmail", tokenScope: "tenant", scopes: ["gmail.send"] },
			],
			policies: [],
			runtime: null,
			layout: null,
			outputs: [],
		},
	};
}

const EXPORT_INPUT = {
	blueprint: blueprintRow(),
	revision: revisionRow(),
	definition: definition(),
	organizationName: "Second Org",
	exportedByKind: "user" as const,
	exportedAt: "2026-08-17T12:00:00.000Z",
};

describe("blueprint export projection", () => {
	it("emits exactly the allowlisted fields and no principal id", async () => {
		const envelope = await buildOsBlueprintExport(EXPORT_INPUT);

		expect(Object.keys(envelope).sort()).toEqual([
			"blueprint",
			"definition",
			"envelopeVersion",
			"exportedAt",
			"exportedByKind",
			"lineage",
			"revision",
			"source",
		]);
		// Presentation only: no visibility, no ids, no timestamps of the row.
		expect(envelope.blueprint).toEqual({
			name: "Sales Pod",
			description: "Shared sales pod",
			status: "published",
		});
		// Revision metadata carries the principal KIND, never the principal.
		expect(envelope.revision).toEqual({
			revision: 3,
			createdAt: "2026-08-02T00:00:00.000Z",
			publishedAt: "2026-08-02T01:00:00.000Z",
			createdByKind: "tedi",
		});
		expect(envelope.definition).toEqual(definition());

		const serialized = JSON.stringify(envelope);
		// The author's principal ids are on both source rows and travel nowhere.
		expect(serialized).not.toContain("descope-sub-of-the-author");
		expect(serialized).not.toContain("tedi-id-of-the-author");
		// The source org's catalog decision is its own; an import cannot inherit it.
		expect(serialized).not.toContain("catalog");
		// The envelope round-trips through the strict contract schema.
		expect(OsBlueprintExportSchema.parse(envelope)).toEqual(envelope);
	});

	it("names the origin with everything a fork needs when the source is unreachable", async () => {
		const envelope = await buildOsBlueprintExport(EXPORT_INPUT);

		expect(envelope.source).toEqual({
			organizationId: "org-source",
			organizationName: "Second Org",
			blueprintId: SOURCE_BLUEPRINT_ID,
			blueprintName: "Sales Pod",
			revisionId: SOURCE_REVISION_ID,
			revision: 3,
			definitionSha256: await canonicalDigest(definition()),
			forkedAt: "2026-08-17T12:00:00.000Z",
			via: "export",
			// Attested on the EXPORTING side: the platform read these rows.
			attested: true,
		});
		// The one place tenant identity appears is the ORIGIN's, deliberately: it
		// is what makes the fork nameable later.
		expect(envelope.source.organizationId).toBe(
			EXPORT_INPUT.blueprint.organizationId,
		);
	});

	it("carries the exported blueprint's own ancestry, so a fork of a fork keeps its chain", async () => {
		const ancestor = {
			organizationId: "org-original",
			organizationName: "Original Org",
			blueprintId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
			blueprintName: "Origin Pod",
			revisionId: "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a",
			revision: 1,
			definitionSha256: "a".repeat(64),
			forkedAt: "2026-07-01T00:00:00.000Z",
			via: "gallery" as const,
			// Stored as attested by the gallery fork that wrote it; re-exporting
			// downgrades every inherited ancestor, which the assertion checks.
			attested: true,
		};
		const envelope = await buildOsBlueprintExport({
			...EXPORT_INPUT,
			blueprint: blueprintRow({
				lineage: JSON.stringify({
					version: 1,
					chain: [ancestor],
					truncated: false,
				}),
			}),
		});
		expect(envelope.lineage).toEqual({
			version: 1,
			chain: [ancestor],
			truncated: false,
		});
	});
});

describe("export digest verification", () => {
	it("accepts an envelope whose digest describes the definition it carries", async () => {
		const envelope = await buildOsBlueprintExport(EXPORT_INPUT);
		await expect(verifyOsBlueprintExport(envelope)).resolves.toEqual({
			ok: true,
			definitionSha256: envelope.source.definitionSha256,
		});
	});

	it("rejects an envelope that names an ancestor whose content it does not contain", async () => {
		const envelope = await buildOsBlueprintExport(EXPORT_INPUT);
		const tampered = {
			...envelope,
			definition: {
				...envelope.definition,
				gadgets: [
					{
						name: "Backdoor",
						manifest: { entry: "backdoor.ts", capabilities: [] },
					},
				],
			},
		};
		const result = await verifyOsBlueprintExport(tampered);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.expected).toBe(envelope.source.definitionSha256);
		expect(result.actual).not.toBe(result.expected);
	});

	it("digests the parsed VALUE, not its serialization, so key order cannot change identity", async () => {
		// The same definition reached by a different parse path serializes to
		// different bytes; a fork digest that moved with byte order would fail to
		// identify an ancestor it genuinely describes.
		const reordered = {
			requirements: definition().requirements,
			gadgets: definition().gadgets,
		} as OsBlueprintDefinition;
		expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(definition()));
		expect(canonicalJson(reordered)).toBe(canonicalJson(definition()));
		await expect(canonicalDigest(reordered)).resolves.toBe(
			await canonicalDigest(definition()),
		);
	});
});

describe("fork lineage", () => {
	function entry(index: number) {
		return {
			organizationId: `org-${index}`,
			organizationName: `Org ${index}`,
			blueprintId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			blueprintName: `Pod ${index}`,
			revisionId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			revision: 1,
			definitionSha256: "b".repeat(64),
			forkedAt: "2026-08-01T00:00:00.000Z",
			via: "export" as const,
			// Envelope entries are caller-asserted, never platform-verified.
			attested: false,
		};
	}

	it("puts the newest fork at the head of the chain it inherited", () => {
		const lineage = buildForkLineage(entry(1), {
			version: 1,
			chain: [entry(2), entry(3)],
			truncated: false,
		});
		expect(lineage.chain.map((item) => item.organizationId)).toEqual([
			"org-1",
			"org-2",
			"org-3",
		]);
		expect(lineage.truncated).toBe(false);
	});

	it("caps the chain and flags the truncation rather than silently shortening history", () => {
		const long = Array.from({ length: 20 }, (_, index) => entry(index + 2));
		const lineage = buildForkLineage(entry(1), {
			version: 1,
			chain: long,
			truncated: false,
		});
		expect(lineage.chain).toHaveLength(20);
		expect(lineage.chain[0]?.organizationId).toBe("org-1");
		expect(lineage.truncated).toBe(true);

		// Once anything anywhere in the history was dropped, the flag stays true —
		// a reader must never mistake a trimmed chain for a complete one.
		const later = buildForkLineage(entry(0), {
			version: 1,
			chain: [entry(1)],
			truncated: true,
		});
		expect(later.chain).toHaveLength(2);
		expect(later.truncated).toBe(true);
	});

	it("starts a chain when the forked blueprint was hand-authored", () => {
		expect(buildForkLineage(entry(1), null)).toEqual({
			version: 1,
			chain: [entry(1)],
			truncated: false,
		});
	});

	it("downgrades every inherited ancestor to unattested", () => {
		// A fork verifies its IMMEDIATE source by reading those rows. It cannot
		// verify what that source claimed about ITS ancestors, and an envelope's
		// whole chain is caller-supplied — so propagating an inherited
		// `attested: true` would let one forged link launder the rest.
		const lineage = buildForkLineage(
			{ ...entry(1), attested: true },
			{
				version: 1,
				chain: [
					{ ...entry(2), attested: true },
					{ ...entry(3), attested: true },
				],
				truncated: false,
			},
		);
		expect(lineage.chain[0]?.attested).toBe(true);
		expect(lineage.chain.slice(1).map((item) => item.attested)).toEqual([
			false,
			false,
		]);
	});

	it("reports an unreadable stored chain as absent instead of reconstructing one", () => {
		expect(parseBlueprintLineage(null)).toBeNull();
		expect(parseBlueprintLineage("not json")).toBeNull();
		// Structurally wrong (an empty chain claims ancestry it cannot name).
		expect(
			parseBlueprintLineage('{"version":1,"chain":[],"truncated":false}'),
		).toBeNull();
		expect(
			parseBlueprintLineage(
				JSON.stringify({ version: 1, chain: [entry(1)], truncated: false }),
			),
		).toEqual({ version: 1, chain: [entry(1)], truncated: false });
	});
});
