import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	createOsCollaborationProposal,
	decideOsCollaborationProposal,
	getOsCollaborationProposal,
	listOsCollaborationProposals,
	mergeOsCollaborationProposal,
	updateOsCollaborationProposalPreview,
} from "./collaboration";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		CREATE TABLE os_workspaces (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			source_blueprint_id TEXT,
			source_blueprint_revision_id TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE os_gadgets (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL REFERENCES os_workspaces(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			current_revision_id TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE os_gadget_revisions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			gadget_id TEXT NOT NULL REFERENCES os_gadgets(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			manifest TEXT NOT NULL,
			source_artifact_ref TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (gadget_id, revision)
		);
		CREATE TABLE os_outputs (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			current_revision_id TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE os_output_revisions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			output_id TEXT NOT NULL REFERENCES os_outputs(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			content TEXT NOT NULL,
			note TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			-- Appended last, matching the ALTER TABLE order production will have.
			-- The revision writers use INSERT..SELECT with no column list and bind
			-- positionally, so this fixture only exercises the real binding when
			-- its column order matches the migrated table.
			skill_run_id TEXT,
			skill_id TEXT,
			access_envelope TEXT,
			UNIQUE (output_id, revision)
		);
		CREATE TABLE os_gadget_executions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			run_id TEXT,
			resource_access_envelope TEXT
		);
		CREATE TABLE os_collaboration_proposals (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL REFERENCES os_workspaces(id) ON DELETE CASCADE,
			document_type TEXT NOT NULL,
			document_id TEXT NOT NULL,
			base_revision_id TEXT NOT NULL,
			base_revision INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			source_kind TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_attestation_version INTEGER,
			content TEXT NOT NULL,
			sequence INTEGER NOT NULL DEFAULT 0,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			decision_rationale TEXT,
			decision_evidence_refs TEXT NOT NULL DEFAULT '[]',
			decided_by_kind TEXT,
			decided_by_id TEXT,
			decided_at TEXT,
			merge_rationale TEXT,
			merge_evidence_refs TEXT NOT NULL DEFAULT '[]',
			merged_by_kind TEXT,
			merged_by_id TEXT,
			merged_at TEXT,
			result_revision_id TEXT,
			result_revision INTEGER
		);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
		INSERT INTO os_workspaces VALUES (
			'ws-1', 'org-1', 'Ops room', NULL, 'active', NULL, NULL,
			'user', 'u-1', '2026-08-17T10:00:00.000Z', '2026-08-17T10:00:00.000Z'
		);
		INSERT INTO os_outputs VALUES (
			'out-1', 'org-1', 'ws-1', 'document', 'Brief', 'active', 'out-rev-1',
			'user', 'u-1', '2026-08-17T10:00:00.000Z', '2026-08-17T10:00:00.000Z'
		);
		INSERT INTO os_output_revisions VALUES (
			'out-rev-1', 'org-1', 'out-1', 1,
			'{"kind":"document","blocks":[]}', NULL,
			'user', 'u-1', '2026-08-17T10:00:00.000Z',
			NULL, NULL, '{"version":1,"sources":[]}'
		);
		INSERT INTO os_gadgets VALUES (
			'gadget-1', 'org-1', 'ws-1', 'Report', NULL, 'active', 'gadget-rev-1',
			'user', 'u-1', '2026-08-17T10:00:00.000Z', '2026-08-17T10:00:00.000Z'
		);
		INSERT INTO os_gadget_revisions VALUES (
			'gadget-rev-1', 'org-1', 'gadget-1', 1,
			'{"entry":"main.tsx","capabilities":[]}', NULL,
			'user', 'u-1', '2026-08-17T10:00:00.000Z'
		);
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const createdAt = "2026-08-17T10:05:00.000Z";

async function seedProposal(
	db: ReturnType<typeof fixture>["db"],
	overrides: Record<string, unknown> = {},
) {
	return createOsCollaborationProposal(db, {
		id: "proposal-1",
		organizationId: "org-1",
		workspaceId: "ws-1",
		documentType: "output",
		documentId: "out-1",
		baseRevisionId: "out-rev-1",
		baseRevision: 1,
		status: "open",
		sourceKind: "agent_session",
		sourceId: "codex:session-1",
		sourceAttestationVersion: 1,
		content:
			'{"kind":"document","blocks":[{"type":"paragraph","text":"draft"}]}',
		sequence: 0,
		createdByKind: "external_agent",
		createdById: "ada-coding-agents",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	});
}

const decision = {
	organizationId: "org-1",
	proposalId: "proposal-1",
	expectedSequence: 1,
	rationale: "Reviewed against the live human draft",
	evidenceRefs: '["canvas://review/1"]',
	decidedByKind: "user" as const,
	decidedById: "u-1",
};

describe("OS collaboration proposals", () => {
	it("streams sequence-CAS previews, freezes them on acceptance, and scopes reads", async () => {
		const { db } = fixture();
		await seedProposal(db);
		const preview = await updateOsCollaborationProposalPreview(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			content:
				'{"kind":"document","blocks":[{"type":"paragraph","text":"preview 1"}]}',
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
		});
		expect(preview).toMatchObject({ sequence: 1, status: "open" });
		expect(
			await updateOsCollaborationProposalPreview(db, {
				organizationId: "org-1",
				proposalId: "proposal-1",
				expectedSequence: 0,
				content: "{}",
				sourceKind: "agent_session",
				sourceId: "codex:session-1",
			}),
		).toBeUndefined();

		const accepted = await decideOsCollaborationProposal(db, {
			...decision,
			decision: "accepted",
		});
		expect(accepted).toMatchObject({ status: "accepted", sequence: 1 });
		expect(
			await updateOsCollaborationProposalPreview(db, {
				organizationId: "org-1",
				proposalId: "proposal-1",
				expectedSequence: 1,
				content: "{}",
				sourceKind: "agent_session",
				sourceId: "codex:session-1",
			}),
		).toBeUndefined();
		expect(await listOsCollaborationProposals(db, "org-1")).toHaveLength(1);
		expect(await listOsCollaborationProposals(db, "org-2")).toHaveLength(0);
		expect(
			await getOsCollaborationProposal(db, {
				organizationId: "org-2",
				proposalId: "proposal-1",
			}),
		).toBeUndefined();
	});

	it("keeps rejected previews non-canonical", async () => {
		const { db, sqlite } = fixture();
		await seedProposal(db);
		const rejected = await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "rejected",
		});
		expect(rejected).toMatchObject({ status: "rejected" });
		expect(
			await mergeOsCollaborationProposal(db, {
				organizationId: "org-1",
				proposalId: "proposal-1",
				expectedSequence: 0,
				revisionId: "out-rev-2",
				rationale: "must not merge",
				evidenceRefs: "[]",
				mergedByKind: "user",
				mergedById: "u-1",
			}),
		).toEqual({ ok: false, reason: "proposal_conflict" });
		expect(
			sqlite
				.prepare("SELECT current_revision_id FROM os_outputs WHERE id = ?")
				.get("out-1"),
		).toEqual({ current_revision_id: "out-rev-1" });
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM os_output_revisions").get(),
		).toEqual({ count: 1 });
	});

	it("atomically merges an accepted output preview into one immutable revision", async () => {
		const { db, sqlite } = fixture();
		await seedProposal(db);
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const merged = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "Human approved final preview",
			evidenceRefs: '["canvas://review/2"]',
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(merged).toMatchObject({
			ok: true,
			proposal: { status: "merged", resultRevision: 2 },
			revision: { id: "out-rev-2", revision: 2 },
		});
		expect(
			sqlite
				.prepare("SELECT current_revision_id FROM os_outputs WHERE id = ?")
				.get("out-1"),
		).toEqual({ current_revision_id: "out-rev-2" });
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM os_output_revisions").get(),
		).toEqual({ count: 2 });
		// The merged revision credits the agent session that authored the bytes,
		// not the operator who approved them — the operator is already created_by.
		// This proposal's source is an agent_session, not a run, so no producing
		// run is claimed.
		expect(
			sqlite
				.prepare(
					"SELECT skill_run_id, skill_id, created_by_id FROM os_output_revisions WHERE id = ?",
				)
				.get("out-rev-2"),
		).toEqual({ skill_run_id: null, skill_id: null, created_by_id: "u-1" });
	});

	it("credits the producing run when the merged proposal came from one", async () => {
		const { sqlite, db } = fixture();
		await seedProposal(db, {
			sourceKind: "run",
			sourceId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
		});
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const merged = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "Human approved the agent run's output",
			evidenceRefs: '["canvas://review/2"]',
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(merged.ok).toBe(true);
		expect(
			sqlite
				.prepare(
					"SELECT skill_run_id, created_by_id FROM os_output_revisions WHERE id = ?",
				)
				.get("out-rev-2"),
		).toEqual({
			skill_run_id: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
			created_by_id: "u-1",
		});
	});

	it.each([
		{
			label: "legacy run",
			sourceKind: "run" as const,
			sourceId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
			sourceAttestationVersion: null,
		},
		{
			label: "attested agent session",
			sourceKind: "agent_session" as const,
			sourceId: "codex:session-1",
			sourceAttestationVersion: 1,
		},
	])(
		"makes $label lineage unshareable without a producer envelope",
		async (source) => {
			const { sqlite, db } = fixture();
			const runId = "9f1e2d3c-4b5a-4697-8899-aabbccddeeff";
			const baseEnvelope = JSON.stringify({
				version: 1,
				sources: [
					{
						workspaceResourceId: "11111111-1111-4111-8111-111111111111",
						workspaceId: "22222222-2222-4222-8222-222222222222",
						providerId: "google-drive",
						resourceType: "document",
						providerResourceId: "doc-base",
						connectionScope: "tenant",
						requiredScopes: ["documents.read"],
						operations: ["read"],
					},
				],
			});
			sqlite
				.prepare(
					"UPDATE os_output_revisions SET access_envelope = ? WHERE id = ?",
				)
				.run(baseEnvelope, "out-rev-1");
			sqlite
				.prepare("INSERT INTO os_gadget_executions VALUES (?, ?, ?, ?)")
				.run("exec-legacy", "org-1", runId, '{"version":1,"sources":[]}');
			await seedProposal(db, source);
			await decideOsCollaborationProposal(db, {
				...decision,
				expectedSequence: 0,
				decision: "accepted",
			});
			const merged = await mergeOsCollaborationProposal(db, {
				organizationId: "org-1",
				proposalId: "proposal-1",
				expectedSequence: 0,
				revisionId: "out-rev-2",
				rationale: "Legacy content reviewed without producer attestation",
				evidenceRefs: "[]",
				mergedByKind: "user",
				mergedById: "u-1",
			});
			expect(merged).toMatchObject({
				ok: true,
				revision: { skillRunId: null, accessEnvelope: null },
			});
		},
	);

	it("merges base and producing-run access lineage", async () => {
		const { sqlite, db } = fixture();
		const baseSource = {
			workspaceResourceId: "11111111-1111-4111-8111-111111111111",
			workspaceId: "22222222-2222-4222-8222-222222222222",
			providerId: "google-drive",
			resourceType: "document",
			providerResourceId: "doc-1",
			connectionScope: "tenant",
			requiredScopes: ["documents.read"],
			operations: ["read"],
		};
		const producerSource = {
			...baseSource,
			workspaceResourceId: "33333333-3333-4333-8333-333333333333",
			providerResourceId: "doc-2",
		};
		sqlite
			.prepare(
				"UPDATE os_output_revisions SET access_envelope = ? WHERE id = ?",
			)
			.run(JSON.stringify({ version: 1, sources: [baseSource] }), "out-rev-1");
		sqlite
			.prepare("INSERT INTO os_gadget_executions VALUES (?, ?, ?, ?)")
			.run(
				"exec-1",
				"org-1",
				"9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
				JSON.stringify({ version: 1, sources: [producerSource] }),
			);
		await seedProposal(db, {
			sourceKind: "run",
			sourceId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
		});
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const merged = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "Reviewed",
			evidenceRefs: "[]",
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(merged.ok).toBe(true);
		const row = sqlite
			.prepare("SELECT access_envelope FROM os_output_revisions WHERE id = ?")
			.get("out-rev-2") as { access_envelope: string };
		expect(JSON.parse(row.access_envelope)).toEqual({
			version: 1,
			sources: [baseSource, producerSource],
		});
	});

	it("fails closed for duplicate same-org run receipts and ignores foreign-org rows", async () => {
		const { sqlite, db } = fixture();
		const runId = "9f1e2d3c-4b5a-4697-8899-aabbccddeeff";
		const envelope = '{"version":1,"sources":[]}';
		sqlite
			.prepare("INSERT INTO os_gadget_executions VALUES (?, ?, ?, ?)")
			.run("foreign", "org-2", runId, "malformed-foreign-envelope");
		sqlite
			.prepare("INSERT INTO os_gadget_executions VALUES (?, ?, ?, ?)")
			.run("same-1", "org-1", runId, envelope);
		await seedProposal(db, { sourceKind: "run", sourceId: runId });
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const first = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "Foreign receipt must not participate",
			evidenceRefs: "[]",
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(first).toMatchObject({
			ok: true,
			revision: { accessEnvelope: envelope },
		});

		const secondFixture = fixture();
		secondFixture.sqlite
			.prepare(
				"INSERT INTO os_gadget_executions VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
			)
			.run(
				"duplicate-1",
				"org-1",
				runId,
				envelope,
				"duplicate-2",
				"org-1",
				runId,
				envelope,
			);
		await seedProposal(secondFixture.db, {
			sourceKind: "run",
			sourceId: runId,
		});
		await decideOsCollaborationProposal(secondFixture.db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const ambiguous = await mergeOsCollaborationProposal(secondFixture.db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "Ambiguous producer",
			evidenceRefs: "[]",
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(ambiguous).toMatchObject({
			ok: true,
			revision: { accessEnvelope: null },
		});
	});

	it("rolls back the batch when the canonical base moved before merge", async () => {
		const { db, sqlite } = fixture();
		await seedProposal(db);
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		sqlite.exec(`
			INSERT INTO os_output_revisions VALUES (
				'out-racing-rev', 'org-1', 'out-1', 2,
				'{"kind":"document","blocks":[]}', 'human race',
				'user', 'u-2', '2026-08-17T10:10:00.000Z',
				NULL, NULL, '{"version":1,"sources":[]}'
			);
			UPDATE os_outputs SET current_revision_id = 'out-racing-rev' WHERE id = 'out-1';
		`);
		const merged = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "out-rev-2",
			rationale: "stale attempt",
			evidenceRefs: "[]",
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(merged).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			sqlite
				.prepare("SELECT status FROM os_collaboration_proposals WHERE id = ?")
				.get("proposal-1"),
		).toEqual({ status: "accepted" });
		expect(
			sqlite.prepare("SELECT id FROM os_output_revisions ORDER BY id").all(),
		).toEqual([{ id: "out-racing-rev" }, { id: "out-rev-1" }]);
	});

	it("uses the same fenced merge path for gadget manifests", async () => {
		const { db, sqlite } = fixture();
		await seedProposal(db, {
			documentType: "gadget",
			documentId: "gadget-1",
			baseRevisionId: "gadget-rev-1",
			content: '{"entry":"proposal.tsx","capabilities":[]}',
		});
		await decideOsCollaborationProposal(db, {
			...decision,
			expectedSequence: 0,
			decision: "accepted",
		});
		const merged = await mergeOsCollaborationProposal(db, {
			organizationId: "org-1",
			proposalId: "proposal-1",
			expectedSequence: 0,
			revisionId: "gadget-rev-2",
			rationale: "Manifest reviewed",
			evidenceRefs: "[]",
			mergedByKind: "user",
			mergedById: "u-1",
		});
		expect(merged).toMatchObject({
			ok: true,
			revision: { id: "gadget-rev-2", revision: 2 },
		});
		expect(
			sqlite
				.prepare("SELECT current_revision_id FROM os_gadgets WHERE id = ?")
				.get("gadget-1"),
		).toEqual({ current_revision_id: "gadget-rev-2" });
	});
});
