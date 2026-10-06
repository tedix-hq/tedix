import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import {
	WorkflowImageCleanup,
	WORKFLOW_IMAGE_CLEANUP_PREFIX,
	type WorkflowImageCleanupInput,
	type WorkflowImageCleanupAuthority,
} from "../src/workflow-image-cleanup";
import {
	describeWorkflowImages,
	persistWorkflowImages,
} from "../src/workflow-image-handoff";
import type { PiStorageFixture } from "./pi-runtime/storage-fixture";
import { RuntimeAdmissionDO } from "../src/runtime-admission-do";
const bindings = env as unknown as {
	PI_STORAGE: DurableObjectNamespace<PiStorageFixture>;
	TEDI_STORAGE: R2Bucket;
};
const image = {
	kind: "base64" as const,
	data: "aGk=",
	mediaType: "image/png",
	fileName: "image.png",
};
async function ports(
	storage: DurableObjectStorage,
	objectId: string,
	tediId: string,
) {
	// This isolated fixture explicitly seeds its native stored tenant identity.
	storage.sql.exec(
		"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
	);
	storage.sql.exec(
		"INSERT OR IGNORE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
		JSON.stringify({ tediId, orgId: "image-org" }),
	);
	const admission = new RuntimeAdmissionDO(storage, {
		objectId,
		tediId,
		orgId: "image-org",
	});
	if (!admission.read())
		admission.gate.initialize({
			operationId: "explicit-fixture-baseline",
			state: "active",
			evidence: await admission.prepareEvidence("initialize"),
		});
	const original = async (
		authority: WorkflowImageCleanupAuthority,
		input: WorkflowImageCleanupInput,
	) => {
		const accepted = await admission.assertOriginalClaim({
			runId: authority.runId,
			sessionKey: input.sessionKey,
			principalId: input.tediId,
			input,
		});
		expect(accepted.generation).toBe(authority.generation);
		expect(accepted.requestHash).toBe(authority.requestHash);
	};
	return {
		owner: () => ({ tediId, orgId: "image-org" }),
		admitCleanup: async (input: WorkflowImageCleanupInput) => {
			// This native fixture explicitly accepts the immutable original upload first.
			await admission.beginAcceptedTurn({
				runId: input.runId,
				sessionKey: input.sessionKey,
				principalId: tediId,
				input: { kind: "image-upload", refs: input.refs },
				expectedGeneration: admission.read()!.generation,
			});
			await admission.assertAcceptedTurn({ runId: input.runId });
			const { accepted } = await admission.beginAcceptedTurn({
				runId: `workflow-image-cleanup:${input.runId}`,
				sessionKey: input.sessionKey,
				principalId: tediId,
				input,
				expectedGeneration: admission.read()!.generation,
			});
			return {
				runId: accepted.runId,
				generation: accepted.generation,
				requestHash: accepted.requestHash,
			};
		},
		assertCleanupOriginal: original,
		assertCleanupActive: async (
			authority: WorkflowImageCleanupAuthority,
			input: WorkflowImageCleanupInput,
		) => {
			await original(authority, input);
			const accepted = await admission.assertAcceptedTurn({
				runId: authority.runId,
				input,
			});
			return () => {
				admission.assertAcceptedTurnSync({
					runId: authority.runId,
					expected: accepted,
				});
			};
		},
		completeCleanup: async (
			authority: WorkflowImageCleanupAuthority,
			input: WorkflowImageCleanupInput,
			receipt: unknown,
		) => {
			await original(authority, input);
			const accepted = await admission.recordTerminalReceipt(authority.runId, {
				sourceId: `${authority.runId}:r2-final-page`,
				receipt,
			});
			const claim = {
				turnId: accepted.runId,
				generation: accepted.generation,
				requestHash: accepted.requestHash,
				submissionId: `${authority.runId}:r2-final-page`,
			};
			admission.gate.completeTurn({
				...claim,
				evidence: await admission.prepareEvidence("complete", claim),
			});
		},
	};
}
it("recovers partial private writes through real SQLite/R2 after cold reconstruction", async () => {
	const tediId = crypto.randomUUID();
	const runId = crypto.randomUUID();
	const workflowInstanceId = crypto.randomUUID();
	const id = bindings.PI_STORAGE.idFromName(tediId);
	await runInDurableObject(
		bindings.PI_STORAGE.get(id),
		async (_instance, state) => {
			const refs = await describeWorkflowImages(tediId, runId, [image]);
			const journal = new WorkflowImageCleanup({
				storage: state.storage,
				...(await ports(state.storage, state.id.toString(), tediId)),
				bucket: () => bindings.TEDI_STORAGE,
				nativeStatus: async () => {
					throw new Error("(instance.not_found)");
				},
				canceled: async () => false,
			});
			await journal.withRun(runId, async () => {
				await journal.claim(runId, workflowInstanceId, refs, "images");
				expect(
					await state.storage.get(`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`),
				).toBeDefined();
				const bucket = {
					get: bindings.TEDI_STORAGE.get.bind(bindings.TEDI_STORAGE),
					list: bindings.TEDI_STORAGE.list.bind(bindings.TEDI_STORAGE),
					delete: bindings.TEDI_STORAGE.delete.bind(bindings.TEDI_STORAGE),
					put: async (
						key: string,
						body: Parameters<R2Bucket["put"]>[1],
						options?: R2PutOptions,
					) => {
						if (!key.endsWith("manifest.json"))
							throw new Error("simulated eviction before payload");
						return bindings.TEDI_STORAGE.put(key, body, options);
					},
				};
				await expect(
					persistWorkflowImages(bucket, tediId, runId, [image], () =>
						journal.assertUploadReady(runId),
					),
				).rejects.toThrow("simulated eviction");
			});
			expect(
				(
					await bindings.TEDI_STORAGE.list({
						prefix: `__runtime/workflow-images/${tediId}/${runId}/`,
					})
				).objects,
			).toHaveLength(1);
		},
	);
	await abortAllDurableObjects();
	await runInDurableObject(
		bindings.PI_STORAGE.get(id),
		async (_instance, state) => {
			const journal = new WorkflowImageCleanup({
				storage: state.storage,
				...(await ports(state.storage, state.id.toString(), tediId)),
				bucket: () => bindings.TEDI_STORAGE,
				nativeStatus: async () => {
					throw new Error("(instance.not_found)");
				},
				canceled: async () => false,
			});
			expect((await journal.redrive()).cleaned).toBe(1);
			expect(
				(
					await bindings.TEDI_STORAGE.list({
						prefix: `__runtime/workflow-images/${tediId}/${runId}/`,
					})
				).objects,
			).toHaveLength(0);
			expect(
				await state.storage.get(`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`),
			).toMatchObject({ completed: true, page: { stage: "acknowledged" } });
			const changed = await describeWorkflowImages(tediId, runId, [
				{ ...image, data: "Ynk=" },
			]);
			await expect(
				journal.claim(runId, workflowInstanceId, changed, "images"),
			).rejects.toThrow("workflow_image_conflict");
		},
	);
});
it("retains lost terminal delete acknowledgement without replay on another wake", async () => {
	const tediId = crypto.randomUUID();
	const runId = crypto.randomUUID();
	const workflowInstanceId = crypto.randomUUID();
	await runInDurableObject(
		bindings.PI_STORAGE.get(bindings.PI_STORAGE.idFromName(tediId)),
		async (_instance, state) => {
			let failDelete = true;
			let status = "running";
			const retries: unknown[] = [];
			const bucket = {
				get: bindings.TEDI_STORAGE.get.bind(bindings.TEDI_STORAGE),
				put: bindings.TEDI_STORAGE.put.bind(bindings.TEDI_STORAGE),
				list: bindings.TEDI_STORAGE.list.bind(bindings.TEDI_STORAGE),
				delete: async (keys: string | string[]) => {
					if (failDelete) throw new Error("delete unavailable");
					return bindings.TEDI_STORAGE.delete(keys);
				},
			};
			const deps = {
				storage: state.storage,
				...(await ports(state.storage, state.id.toString(), tediId)),
				bucket: () => bucket,
				nativeStatus: async () => status,
				canceled: async () => false,
				scheduleRetry: async (input: unknown) => {
					retries.push(input);
					throw new Error("scheduler unavailable");
				},
			};
			const journal = new WorkflowImageCleanup(deps);
			await journal.withRun(runId, async () => {
				await journal.claim(
					runId,
					workflowInstanceId,
					await describeWorkflowImages(tediId, runId, [image]),
					"images",
				);
				await persistWorkflowImages(bucket, tediId, runId, [image], () =>
					journal.assertUploadReady(runId),
				);
				await journal.beforeDispatch(runId, workflowInstanceId);
			});
			expect(
				await journal.terminal({
					runId,
					workflowInstanceId,
					intent: "terminal",
				}),
			).toBe("retained");
			expect(retries).toHaveLength(1);
			status = "complete";
			expect(
				await journal.terminal({
					runId,
					workflowInstanceId,
					intent: "terminal",
					attempt: 10,
				}),
			).toBe("failed");
			expect(retries).toHaveLength(1);
			expect(
				await state.storage.get(`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`),
			).toBeDefined();
			failDelete = false;
			expect((await new WorkflowImageCleanup(deps).redrive()).cleaned).toBe(0);
			expect(
				(
					await bindings.TEDI_STORAGE.list({
						prefix: `__runtime/workflow-images/${tediId}/${runId}/`,
					})
				).objects,
			).toHaveLength(2);
		},
	);
});
it("retains actual final delete ACK after quarantine and eviction under the original claim", async () => {
	const tediId = crypto.randomUUID(),
		runId = crypto.randomUUID(),
		workflowInstanceId = crypto.randomUUID();
	const id = bindings.PI_STORAGE.idFromName(tediId),
		stub = bindings.PI_STORAGE.get(id);
	await runInDurableObject(stub, async (_instance, state) => {
		const admissionPorts = await ports(
			state.storage,
			state.id.toString(),
			tediId,
		);
		const admission = new RuntimeAdmissionDO(state.storage, {
			objectId: state.id.toString(),
			tediId,
			orgId: "image-org",
		});
		let deletes = 0;
		const bucket = {
			get: bindings.TEDI_STORAGE.get.bind(bindings.TEDI_STORAGE),
			put: bindings.TEDI_STORAGE.put.bind(bindings.TEDI_STORAGE),
			list: bindings.TEDI_STORAGE.list.bind(bindings.TEDI_STORAGE),
			delete: async (keys: string | string[]) => {
				deletes++;
				await bindings.TEDI_STORAGE.delete(keys);
				admission.gate.quarantine({
					operationId: "revoke-after-actual-delete-ack",
					expectedGeneration: admission.read()!.generation,
					reason: "fixture-authority-revoked",
				});
			},
		};
		const journal = new WorkflowImageCleanup({
			...admissionPorts,
			storage: state.storage,
			bucket: () => bucket,
			nativeStatus: async () => "complete",
			canceled: async () => false,
		});
		const refs = await describeWorkflowImages(tediId, runId, [image]);
		await journal.claim(runId, workflowInstanceId, refs, "images");
		await persistWorkflowImages(bucket, tediId, runId, [image], () =>
			journal.assertUploadReady(runId),
		);
		expect(await journal.attempt(runId)).toBe("cleaned");
		expect(deletes).toBe(1);
		expect(admission.read()!.state).toBe("quarantined");
		expect(
			admission.gate.claim(`workflow-image-cleanup:${runId}`)?.status,
		).toBe("completed");
		await state.storage.put("fixture:delete-count", deletes);
	});
	await abortAllDurableObjects();
	await runInDurableObject(
		bindings.PI_STORAGE.get(id),
		async (_instance, state) => {
			const admissionPorts = await ports(
				state.storage,
				state.id.toString(),
				tediId,
			);
			const journal = new WorkflowImageCleanup({
				...admissionPorts,
				storage: state.storage,
				bucket: () => bindings.TEDI_STORAGE,
				nativeStatus: async () => {
					throw new Error("known ACK must not query/re-dispatch");
				},
				canceled: async () => false,
			});
			expect(await journal.attempt(runId)).toBe("cleaned");
			expect(await state.storage.get("fixture:delete-count")).toBe(1);
			expect(
				await state.storage.get(`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`),
			).toMatchObject({
				completed: true,
				page: { stage: "acknowledged", truncated: false },
			});
		},
	);
});
