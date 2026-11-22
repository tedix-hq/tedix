import { createDbQueryClient } from "@tedix/db/query-client";
import { loadWorkspaceAccess } from "@tedix/db/queries/os-workspace-access";
import {
	grantOsWorkspaceAccess,
	severOsWorkspaceUserAccess,
} from "@tedix/db/queries/os-collaborators";
import {
	createOsWorkspace,
	getOsWorkspace,
	updateOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	createOsGadgetExecution,
	getOsGadgetExecution,
} from "@tedix/db/queries/os-workspaces/executions";
import {
	createOsOutput,
	getOsOutput,
	getOsOutputRevision,
	updateOsOutput,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { readDurableObjectJurisdiction } from "@tedix/worker-kit/durable-objects";
import {
	readOutputBody,
	storeOutputBody,
	type OutputBodyBucket,
} from "./data-port-tenant";
import type { WorkspaceEnv, WorkspaceScope } from "./env";

export type WorkspaceRecoveryPhase = "prepare" | "restore" | "verify";

export async function workspaceRecoveryScope(
	organizationId: string,
	agentId: string,
	drillId: string,
): Promise<WorkspaceScope> {
	const hash = await sha256Hex(
		JSON.stringify(["workspace-recovery-v1", organizationId, agentId, drillId]),
	);
	return {
		organizationId,
		workspaceId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
	};
}

interface FixtureOutput {
	id: string;
	revisionId: string;
	body: string;
	bodyKey: string;
	expectedSha256: string;
}

type Receipt =
	| { state: "preparing" }
	| {
			state: "prepared" | "verified";
			bookmark: string;
			capturedAt: string;
			outputs: FixtureOutput[];
			bodyKeys: string[];
			ownerId: string;
			revokedId: string;
			executionId: string;
			executionSha256: string;
	  };

const markerKey = "workspace-recovery-drill-marker";

export async function runWorkspaceRecoveryDrill(input: {
	ctx: DurableObjectState;
	db: TenantStoreDb;
	env: WorkspaceEnv;
	scope: WorkspaceScope;
	phase: WorkspaceRecoveryPhase;
	agentId: string;
	copyExecution(
		executionId: string,
		output: string,
	): Promise<{ sha256: string }>;
	readExecution(executionId: string, sha256: string): Promise<string>;
	restart: () => void;
}) {
	const { ctx, db, env, scope, phase, restart } = input;
	const shared = createDbQueryClient(env.DB);
	if (readDurableObjectJurisdiction(env) !== "eu") {
		throw new Error("Workspace recovery requires a reserved EU fixture");
	}
	const bucket = env.R2_BUCKET;
	const receiptKey = `workspace-recovery-drill/v1/${encodeURIComponent(scope.organizationId)}/${encodeURIComponent(scope.workspaceId)}/receipt.json`;
	const object = await bucket.get(receiptKey);
	const prior = object ? await object.json<Receipt>() : null;
	if (phase === "prepare") {
		if (prior?.state === "preparing")
			throw new Error("Use a fresh drill ID after interrupted preparation");
		if (prior) return { state: prior.state, capturedAt: prior.capturedAt };
		const reserved = await bucket.put(
			receiptKey,
			JSON.stringify({ state: "preparing" }),
			{
				onlyIf: { etagDoesNotMatch: "*" },
			},
		);
		if (!reserved)
			throw new Error("Workspace recovery fixture is already reserved");
		if (await getOsWorkspace(shared, scope))
			throw new Error("Workspace recovery ID is already in use");
		const witness = scope.workspaceId;
		const now = new Date().toISOString();
		const ownerId = crypto.randomUUID();
		const revokedId = crypto.randomUUID();
		const directory = await createOsWorkspace(shared, {
			id: scope.workspaceId,
			organizationId: scope.organizationId,
			name: scope.workspaceId,
			status: "active",
			visibility: "private",
			ownerUserId: ownerId,
			createdByKind: "external_agent",
			createdById: input.agentId,
		});
		await grantOsWorkspaceAccess(shared, {
			...scope,
			now,
			edges: [
				{
					kind: "user",
					sharerUserId: ownerId,
					targetUserId: revokedId,
					targetEmail: null,
					targetName: null,
					role: "use",
				},
			],
		});
		if (!(await loadWorkspaceAccess(shared, directory, revokedId)).role) {
			throw new Error("Workspace recovery fixture grant was not observed");
		}
		await severOsWorkspaceUserAccess(shared, {
			...scope,
			now,
			targetUserId: revokedId,
			keepEdges: [],
		});
		if (
			(await loadWorkspaceAccess(shared, directory, revokedId)).role !== null
		) {
			throw new Error("Workspace recovery fixture revocation was not observed");
		}
		const executionId = crypto.randomUUID();
		const execution = await input.copyExecution(
			executionId,
			JSON.stringify({ witness }),
		);
		await createOsGadgetExecution(shared, {
			...scope,
			id: executionId,
			gadgetId: crypto.randomUUID(),
			status: "completed",
			grantedCapabilities: '["app.call"]',
			policyDecision: '{"allowed":true,"reasons":[]}',
			runtimeEnvironment: env.ENVIRONMENT,
			completedAt: now,
			workspaceOutputSha256: execution.sha256,
			createdByKind: "external_agent",
			createdById: input.agentId,
		});

		const bodyWitness = crypto.randomUUID();
		const bodies = {
			document: JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: bodyWitness }],
			}),
			sheet: JSON.stringify({
				kind: "sheet",
				columns: ["Recovery"],
				rows: [[bodyWitness]],
			}),
		};
		const outputs: FixtureOutput[] = [];
		const bodyKeys = new Set<string>();
		const captureBucket: OutputBodyBucket = {
			get: (key) => bucket.get(key),
			put: (...args) => {
				bodyKeys.add(args[0]);
				return bucket.put(...args);
			},
		};
		for (const kind of ["document", "sheet"] as const) {
			const id = crypto.randomUUID();
			const revisionId = crypto.randomUUID();
			const body = bodies[kind];
			const stored = await storeOutputBody(
				captureBucket,
				scope.organizationId,
				body,
			);
			const { revision } = await createOsOutput(
				db,
				{
					...scope,
					id,
					kind,
					title: witness,
					currentRevisionId: revisionId,
					createdByKind: "service",
					createdById: "workspace-recovery-drill",
				},
				{
					organizationId: scope.organizationId,
					id: revisionId,
					outputId: id,
					revision: 1,
					content: "",
					...stored,
					createdByKind: "service",
					createdById: "workspace-recovery-drill",
				},
			);
			outputs.push({
				id,
				revisionId,
				body,
				bodyKey: stored.bodyR2Key,
				expectedSha256: await sha256Hex(await readOutputBody(bucket, revision)),
			});
		}
		await ctx.storage.put(markerKey, witness);
		const bookmark = await ctx.storage.getCurrentBookmark();
		const capturedAt = new Date().toISOString();
		for (const output of outputs) {
			await updateOsOutput(
				db,
				{ ...scope, outputId: output.id },
				{ title: "After recovery point" },
			);
		}
		await ctx.storage.put(markerKey, "After recovery point");
		await bucket.put(
			receiptKey,
			JSON.stringify({
				state: "prepared",
				bookmark,
				capturedAt,
				outputs,
				bodyKeys: [...bodyKeys],
				ownerId,
				revokedId,
				executionId,
				executionSha256: execution.sha256,
			}),
		);
		return { state: "prepared", capturedAt } as const;
	}

	if (!prior || prior.state === "preparing")
		throw new Error("Workspace recovery checkpoint is unavailable");
	if (prior.state === "verified")
		return { state: "verified", capturedAt: prior.capturedAt } as const;

	if (phase === "restore") {
		const current = await ctx.storage.get(markerKey);
		if (current === scope.workspaceId)
			return { state: "prepared", capturedAt: prior.capturedAt } as const;
		if (current !== "After recovery point")
			throw new Error("Workspace recovery fixture diverged");
		const directory = await getOsWorkspace(shared, scope);
		if (
			directory?.ownerUserId !== prior.ownerId ||
			directory.createdById !== input.agentId
		) {
			throw new Error("Workspace recovery directory diverged");
		}
		await updateOsWorkspace(shared, scope, { status: "archived" });
		// Only delete bodies with content unique to this reserved fixture.
		await bucket.delete(prior.bodyKeys);
		await ctx.storage.onNextSessionRestoreBookmark(prior.bookmark);
		restart();
		throw new Error("Workspace recovery restart scheduled");
	}

	if ((await ctx.storage.get(markerKey)) !== scope.workspaceId)
		throw new Error("Workspace storage restore has not been observed");
	for (const output of prior.outputs) {
		const row = await getOsOutput(db, { ...scope, outputId: output.id });
		const revision = await getOsOutputRevision(db, {
			organizationId: scope.organizationId,
			revisionId: output.revisionId,
		});
		if (
			row?.title !== scope.workspaceId ||
			row.currentRevisionId !== output.revisionId ||
			!revision
		) {
			throw new Error("Workspace document or sheet metadata did not restore");
		}
		const stored = await storeOutputBody(
			bucket,
			scope.organizationId,
			output.body,
		);
		if (
			stored.bodyR2Key !== output.bodyKey ||
			(await sha256Hex(await readOutputBody(bucket, revision))) !==
				output.expectedSha256
		) {
			throw new Error("Workspace document or sheet body did not restore");
		}
	}
	const directory = await getOsWorkspace(shared, scope);
	if (
		!directory ||
		directory.visibility !== "private" ||
		directory.ownerUserId !== prior.ownerId ||
		directory.createdById !== input.agentId
	) {
		throw new Error("Workspace recovery directory diverged");
	}
	const restored =
		directory.status === "archived"
			? await updateOsWorkspace(shared, scope, { status: "active" })
			: directory;
	if (
		!restored ||
		(await loadWorkspaceAccess(shared, restored, prior.ownerId)).role !==
			"build" ||
		(await loadWorkspaceAccess(shared, restored, prior.revokedId)).role !== null
	) {
		throw new Error("Workspace directory access did not recover");
	}
	const execution = await getOsGadgetExecution(shared, {
		...scope,
		executionId: prior.executionId,
	});
	if (
		execution?.workspaceId !== scope.workspaceId ||
		execution.workspaceOutputSha256 !== prior.executionSha256 ||
		(await input.readExecution(prior.executionId, prior.executionSha256)) !==
			JSON.stringify({ witness: scope.workspaceId })
	) {
		throw new Error("Workspace execution archive did not recover");
	}
	await bucket.put(receiptKey, JSON.stringify({ ...prior, state: "verified" }));
	return { state: "verified", capturedAt: prior.capturedAt } as const;
}
