import { DatabaseSync } from "node:sqlite";
import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type WorkspaceOutputRuntime,
	type OutputQueryResult,
	type DocumentTransfer,
	type DocumentTransferRuntime,
	type DocumentTransferPackage,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
import { continuesOutputAutosaveBurst } from "@tedix/api-contract/utils/os-output-autosave";
import { repointDocumentTransferIndex } from "@tedix/db/queries/workspace-feed/document-transfer";
import {
	osWorkspaceResources,
	osWorkspaces,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";
import {
	workspaceFeedLedger,
	workspaceFeedCursors,
	workspaceActivity,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
import { schemaDdl } from "@tedix/db/test/schema-ddl";

import {
	getOsWorkspace,
	hasSharedWorkspaceOutputs,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	hasWorkspaceOutputAuthority,
	initializeWorkspaceDirectory,
} from "@tedix/db/queries/durable-sqlite/os-outputs";

export function workspaceOutputFixture(
	coreSql: DatabaseSync,
	options: { uninitialized?: boolean; coreSchemaExists?: boolean } = {},
) {
	if (!options.coreSchemaExists)
		coreSql.exec(
			schemaDdl(
				workspaceFeedLedger,
				workspaceFeedCursors,
				workspaceActivity,
				workspaceOutputIndex,
				workspaceWorkLinks,
			),
		);
	const objectSql = new DatabaseSync(":memory:");
	objectSql.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY)");
	objectSql.exec(
		schemaDdl(osWorkspaces, osOutputs, osOutputRevisions, osWorkspaceResources),
	);
	const tenant = createTenantStoreDb(createDurableSqliteFixture(objectSql));
	const core = createDbQueryClient(createD1Facade(coreSql));
	const state = { active: true, importGeneration: 0 };
	const owns = async (scope: { organizationId: string; workspaceId: string }) =>
		state.active &&
		state.importGeneration === 0 &&
		(!options.uninitialized ||
			(await hasWorkspaceOutputAuthority(tenant, scope, core)));
	const plans = new Map<string, DocumentTransfer[]>();
	const excerpts = new Map<string, string>();
	const transfers = new Map<string, DocumentTransferPackage>();
	const runtime: WorkspaceOutputRuntime & DocumentTransferRuntime = {
		async prepareDocumentTransfer(scope, transfer) {
			const key = `${scope.organizationId}:${transfer.transferId}`;
			const saved = transfers.get(key);
			if (saved) {
				if (JSON.stringify(saved.transfer) !== JSON.stringify(transfer))
					throw new Error("Document transfer receipt conflicts");
				return saved;
			}
			if (
				!transfer.transferId ||
				scope.workspaceId !== transfer.sourceWorkspaceId ||
				scope.workspaceId === transfer.targetWorkspaceId ||
				!(await owns(scope))
			)
				throw new Error("Invalid document transfer scope");
			const snapshot = await executeOutputQuery(tenant, scope, {
				op: "snapshot",
				outputId: transfer.outputId,
			});
			if (!snapshot) throw new Error("Document transfer source not found");
			if (
				!snapshot.revisions.length ||
				snapshot.revisions.some((row) => !row.bodyR2Key)
			)
				throw new Error("Document transfer requires R2 revisions");
			const payload = {
				transfer,
				snapshot: {
					...snapshot,
					output: {
						...snapshot.output,
						workspaceId: transfer.targetWorkspaceId,
					},
				},
				batches: [],
			};
			transfers.set(key, payload);
			return payload;
		},
		async importDocumentTransfer(scope, payload) {
			if (
				scope.organizationId !== payload.snapshot.output.organizationId ||
				scope.workspaceId !== payload.transfer.targetWorkspaceId ||
				!(await owns(scope))
			)
				throw new Error("Invalid document transfer scope");
			// This fixture keeps all workspace objects in one database, so moving
			// the row preserves the immutable revisions without copying them.
			await tenant
				.update(osOutputs)
				.set({ workspaceId: scope.workspaceId })
				.where(
					and(
						eq(osOutputs.organizationId, scope.organizationId),
						eq(osOutputs.id, payload.transfer.outputId),
					),
				);
		},
		async confirmDocumentTransfer(scope, transfer) {
			const snapshot = await executeOutputQuery(tenant, scope, {
				op: "snapshot",
				outputId: transfer.outputId,
			});
			if (!snapshot) throw new Error("Document transfer destination not found");
			return snapshot;
		},
		async removeDocumentTransfer(scope, transfer) {
			const payload = transfers.get(
				`${scope.organizationId}:${transfer.transferId}`,
			);
			if (!payload) throw new Error("Document transfer receipt not found");
			payload.completed = true;
		},
		async transferOutput(scope, outputId, targetWorkspaceId) {
			const output = await executeOutputQuery(tenant, scope, {
				op: "get",
				outputId,
			});
			if (!output) return { ok: false, reason: "not_found" };
			if (scope.workspaceId === targetWorkspaceId) return { ok: true, output };
			const transfer = {
				transferId: crypto.randomUUID(),
				outputId,
				sourceWorkspaceId: scope.workspaceId,
				targetWorkspaceId,
			};
			const target = {
				organizationId: scope.organizationId,
				workspaceId: targetWorkspaceId,
			};
			const payload = await runtime.prepareDocumentTransfer(scope, transfer);
			await runtime.importDocumentTransfer(target, payload);
			await repointDocumentTransferIndex(core, scope.organizationId, payload);
			await runtime.removeDocumentTransfer(scope, transfer);
			const confirmed = await runtime.confirmDocumentTransfer(target, transfer);
			return { ok: true, output: confirmed.output };
		},
		outputQuery: async (scope, query) => {
			objectSql
				.prepare("INSERT OR IGNORE INTO organizations VALUES (?)")
				.run(scope.organizationId);
			if (query.op === "initialize") {
				if (!state.active || state.importGeneration > 0)
					throw new Error("Staged workspace requires migration activation");
				const workspace = await getOsWorkspace(core, scope);
				if (!workspace) throw new Error("Workspace directory is missing");
				if (await hasSharedWorkspaceOutputs(core, scope))
					throw new Error("Workspace still has shared documents");
				initializeWorkspaceDirectory(tenant, workspace);
				return "object" as OutputQueryResult<typeof query.op>;
			}
			if (query.op === "authority")
				return ((await owns(scope)) ? "object" : "shared") as OutputQueryResult<
					typeof query.op
				>;
			if (query.op === "placementPlan") {
				if (!(await owns(scope)))
					throw new Error("Document placement requires an object owner");
				const key = `${scope.organizationId}:${scope.workspaceId}:${query.planId}`;
				const documents = [...(plans.get(key) ?? [])];
				for (const document of query.documents) {
					if (
						document.targetWorkspaceId !== scope.workspaceId ||
						document.sourceWorkspaceId === scope.workspaceId
					)
						throw new Error("Invalid document placement scope");
					if (!documents.some((saved) => saved.outputId === document.outputId))
						documents.push(document);
				}
				plans.set(key, documents);
				return documents as OutputQueryResult<typeof query.op>;
			}
			if (
				options.uninitialized &&
				query.op === "create" &&
				!(await owns(scope))
			)
				throw new Error("Workspace does not own these outputs");
			if (query.op === "resources") {
				if (!(await owns(scope)))
					throw new Error("Workspace does not own these resources");
				// Older fixtures model an already initialized owner without its directory row.
				if (!options.uninitialized) {
					const workspace = await getOsWorkspace(core, scope);
					if (workspace) initializeWorkspaceDirectory(tenant, workspace);
				}
			}
			// Like the workspace object, publish the writer's excerpt with the save.
			if (query.op === "create" && query.excerpt)
				excerpts.set(query.revision.id, query.excerpt);
			if (query.op === "revise" && query.excerpt)
				excerpts.set(query.params.id, query.excerpt);
			return executeOutputQuery(tenant, scope, query);
		},
		refreshOutputProjection: async (scope, outputId) => {
			const output = await executeOutputQuery(tenant, scope, {
				op: "get",
				outputId,
			});
			if (!output?.currentRevisionId) return;
			const revision = await executeOutputQuery(tenant, scope, {
				op: "revision",
				revisionId: output.currentRevisionId,
			});
			if (!revision) return;
			const [previous] = await executeOutputQuery(tenant, scope, {
				op: "history",
				outputId,
				options: { limit: 1, beforeRevision: revision.revision },
			});
			await publishOutputProjection(core, output, revision, {
				continuesBurst: continuesOutputAutosaveBurst(previous, revision),
				excerpt: excerpts.get(revision.id),
			});
		},
	};
	const bindings = env as unknown as {
		WORKSPACE_RUNTIME?: WorkspaceOutputRuntime;
	};
	bindings.WORKSPACE_RUNTIME = runtime;
	onTestFinished(() => {
		objectSql.close();
		delete bindings.WORKSPACE_RUNTIME;
	});
	return { objectSql, tenant, runtime, state };
}
