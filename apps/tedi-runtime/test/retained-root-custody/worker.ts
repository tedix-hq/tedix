import { Agent } from "agents";
import { AgentWorkflow, type AgentWorkflowStep } from "agents/workflows";
import { RawCutoverDO as ProductionRaw } from "../../src/pi-cutover-maintenance-do";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
} from "../../src/runtime-admission-do";
import { HistoricalLiabilityCustody } from "../../src/historical-liability-custody";
import { HistoricalTrackingRetirement } from "../../src/historical-tracking-retirement";
import type { WorkflowEvent } from "cloudflare:workers";
type Owner = { tediId: string; orgId: string };
const claimScopes = new Map<
	string,
	{ ctx: DurableObjectState; env: Cloudflare.Env }
>();
const actualClaim = RuntimeAdmissionDO.prototype.assertOriginalClaim;
// Test-only barrier after genuine original claim verification; never supplies or changes the claim.
RuntimeAdmissionDO.prototype.assertOriginalClaim = async function (input) {
	const accepted = await actualClaim.call(this, input),
		scope = claimScopes.get(accepted.owner.objectId);
	const race = scope?.ctx.storage.kv.get("fixture:claim-race");
	if (scope && race) {
		scope.ctx.storage.kv.put("fixture:claim-verified", accepted.runId);
		await scope.env.DB.prepare(
			"UPDATE tedis SET isolate_agent_id='changed-during-genuine-claim' WHERE id=?",
		)
			.bind(accepted.owner.tediId)
			.run();
	}
	return accepted;
};
export class RawCutoverDO extends ProductionRaw {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		const db = new Proxy(env.DB, {
			get(target, key) {
				if (key !== "prepare") {
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (sql: string) => {
					const statement = target.prepare(sql);
					return new Proxy(statement, {
						get(stmt, method) {
							if (method !== "bind") {
								const value = Reflect.get(stmt, method);
								return typeof value === "function" ? value.bind(stmt) : value;
							}
							return (...values: unknown[]) => {
								const bound = stmt.bind(...values);
								return new Proxy(bound, {
									get(query, action) {
										if (action !== "first") {
											const value = Reflect.get(query, action);
											return typeof value === "function"
												? value.bind(query)
												: value;
										}
										return async () => {
											const row = await query.first(),
												race = ctx.storage.kv.get("fixture:db-race");
											if (
												race &&
												((race !== "exposure" && race !== "canonical") ||
													sql.includes("billing_historical_exposures"))
											) {
												ctx.storage.kv.delete("fixture:db-race");
												if (race === "exposure")
													await target
														.prepare(
															"UPDATE billing_historical_exposures SET request_hash=? WHERE object_id=?",
														)
														.bind("f".repeat(64), ctx.id.toString())
														.run();
												else if (race === "canonical")
													await target
														.prepare(
															"UPDATE tedis SET isolate_agent_id=? WHERE id=?",
														)
														.bind(
															"raced-fresh-name",
															readStoredRuntimeAdmission(
																ctx.storage,
																ctx.id.toString(),
															)!.owner.tediId,
														)
														.run();
												else if (race === "registry")
													ctx.storage.sql.exec(
														"UPDATE cf_agents_sub_agents SET identity_name='changed-during-real-D1-await'",
													);
												else {
													const current = readStoredRuntimeAdmission(
														ctx.storage,
														ctx.id.toString(),
													)!;
													// Test-only epoch corruption during the real awaited D1 read; no transition authority is fabricated.
													ctx.storage.sql.exec(
														"UPDATE runtime_admission SET record=? WHERE id=1",
														JSON.stringify({
															...current,
															generation: current.generation + 1,
														}),
													);
												}
											}
											return row;
										};
									},
								});
							};
						},
					});
				};
			},
		});
		super(ctx, { ...env, DB: db });
		claimScopes.set(ctx.id.toString(), { ctx, env });
	}
	/** Test-only audited immutable original ROOT exposure, never financial authority. */
	async freezeRoot() {
		const { HistoricalExposureInputSchema, HistoricalExposureSchema } =
			await import("@tedix/api-contract/schemas/billing");
		const { sha256Hex } = await import("@tedix/worker-kit/crypto");
		const admission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		)!;
		const engine = new HistoricalLiabilityCustody(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
		const inspected = engine.inspectSnapshot({
			expectedGeneration: admission.generation,
		});
		engine.captureSnapshot({
			expectedGeneration: admission.generation,
			expectedSourceHash: inspected.sourceHash,
		});
		const summary = engine.audit()!;
		const input = HistoricalExposureInputSchema.parse({
			tediId: admission.owner.tediId,
			operationId: "fixture-recorded-root",
			rootObjectId: this.ctx.id.toString(),
			objectId: this.ctx.id.toString(),
			targetPath: [],
			expectedGeneration: summary.generation,
			snapshotId: summary.snapshotId,
			sourceHash: summary.sourceHash,
		});
		const observedBy = "fixture-independent-owner",
			observedUserId = "77777777-7777-4777-8777-777777777777",
			orgId = admission.owner.orgId!;
		const requestHash = await sha256Hex(
			JSON.stringify([orgId, observedBy, observedUserId, input]),
		);
		const name = this.ctx.storage.kv.get<string>("__ps_name")!;
		const value = HistoricalExposureSchema.parse({
			id: crypto.randomUUID(),
			organizationId: orgId,
			tediId: admission.owner.tediId,
			rootObjectId: this.ctx.id.toString(),
			rootObjectName: name,
			objectId: this.ctx.id.toString(),
			objectName: name,
			className: "AgentTediDO",
			targetPath: [],
			generation: summary.generation,
			snapshotId: summary.snapshotId,
			sourceHash: summary.sourceHash,
			manifestHash: null,
			originalRunId: null,
			originalWorkId: null,
			originalPeriod: null,
			usage: null,
			costMicros: null,
			effects: "UNKNOWN",
			exposure: "UNKNOWN",
			workflowCount: summary.workflowCount,
			fiberCount: summary.fiberCount,
			identityCount: summary.identityCount,
			observedBy,
			observedUserId,
			observedAt: "2026-10-05T00:00:00.000Z",
			requestHash,
		});
		await this.env.DB.prepare(
			"INSERT INTO billing_historical_exposures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		)
			.bind(
				value.id,
				orgId,
				value.tediId,
				value.objectId,
				name,
				value.generation,
				value.snapshotId,
				value.sourceHash,
				input.operationId,
				requestHash,
				"UNKNOWN",
				JSON.stringify(value),
				observedBy,
				observedUserId,
				value.observedAt,
			)
			.run();
		return value;
	}
	async historical(command: string, generation: number, sourceHash?: string) {
		const admission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		)!;
		const { operateStoredCutover } = await import("../../src/pi-cutover-admin");
		const name = this.ctx.storage.kv.get<string>("__ps_name")!;
		const request = new Request("https://fixture/__admin/pi-state-cutover", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Tedix-Admin-Token": this.env.SECRETS_MASTER_KEY,
			},
			body: JSON.stringify({
				objectId: this.ctx.id.toString(),
				operationId: "fixture-archive-read",
				command,
				expectedGeneration: generation,
				...(sourceHash ? { expectedSourceHash: sourceHash } : {}),
				custody: {
					tediId: admission.owner.tediId,
					orgId: admission.owner.orgId,
					objectName: name,
				},
			}),
		});
		const response = await operateStoredCutover({
			ctx: this.ctx,
			env: {
				...this.env,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([this.ctx.id.toString()]),
			},
			request,
			receiver: "raw-cutover-v1",
		});
		return { status: response.status, body: await response.text() };
	}

	async rootAttempt(input: unknown) {
		try {
			await this._workflow_handleCallback(input);
			return "observed";
		} catch {
			return "rejected";
		}
	}

	async attempt(
		path: unknown,
		method: unknown,
		args: unknown,
	): Promise<string> {
		try {
			await this._cf_invokeAgentPath(path, method, args);
			return "observed";
		} catch {
			return "rejected";
		}
	}
	async warmOriginal(path: string[]): Promise<number> {
		const row = this.ctx.storage.sql
			.exec<{ class: string; name: string; identity_name: string }>(
				"SELECT class,name,identity_name FROM cf_agents_sub_agents WHERE name=?",
				path[0]!,
			)
			.toArray()[0]!;
		const native = this.ctx as DurableObjectState & {
			exports: {
				LegacyChild: DurableObjectClass<LegacyChild>;
				RawCutoverDO: DurableObjectClass<RawCutoverDO>;
			};
		};
		const key = `${row.class}\0${row.name}`;
		if (path.length === 1) {
			this.ctx.facets.abort(key, "fixture warm original");
			const warm = this.ctx.facets.get<LegacyChild>(key, () => ({
				class: native.exports.LegacyChild,
				id: this.env.TEDI_AGENT.idFromName(row.identity_name ?? row.name),
			}));
			try {
				return await warm.startCount();
			} finally {
				(warm as typeof warm & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		}
		const child = this.ctx.facets.get<RawCutoverDO>(key, () => ({
			class: native.exports.RawCutoverDO,
			id: this.env.TEDI_AGENT.idFromName(row.identity_name ?? row.name),
		}));
		try {
			return await child.warmOriginal(path.slice(1));
		} finally {
			(child as typeof child & { [Symbol.dispose]?: () => void })[
				Symbol.dispose
			]?.();
		}
	}
	async witness(
		path: string[],
		mutation?: { kind: string; value: unknown },
	): Promise<string> {
		if (path.length) {
			const row = this.ctx.storage.sql
				.exec<{ class: string; name: string; identity_name: string }>(
					"SELECT class,name,identity_name FROM cf_agents_sub_agents WHERE name=?",
					path[0]!,
				)
				.toArray()[0]!;
			const native = this.ctx as DurableObjectState & {
				exports: { RawCutoverDO: DurableObjectClass<RawCutoverDO> };
			};
			const stub = this.ctx.facets.get<RawCutoverDO>(
				`${row.class}\0${row.name}`,
				() => ({
					class: native.exports.RawCutoverDO,
					id: this.env.TEDI_AGENT.idFromName(row.identity_name ?? row.name),
				}),
			);
			try {
				return await stub.witness(path.slice(1), mutation);
			} finally {
				(stub as typeof stub & { [Symbol.dispose]?: () => void })[
					Symbol.dispose
				]?.();
			}
		}
		if (mutation) {
			if (mutation.kind === "archive") {
				const engine = new HistoricalLiabilityCustody(
						this.ctx.storage,
						this.ctx.id.toString(),
					),
					generation = readStoredRuntimeAdmission(
						this.ctx.storage,
						this.ctx.id.toString(),
					)!.generation,
					summary = engine.inspectSnapshot({ expectedGeneration: generation });
				engine.captureSnapshot({
					expectedGeneration: generation,
					expectedSourceHash: summary.sourceHash,
				});
				new HistoricalTrackingRetirement(
					this.ctx.storage,
					this.ctx.id.toString(),
				).retire({
					operationId: "fixture-retirement",
					expectedGeneration: generation,
					snapshotId: summary.snapshotId,
					sourceHash: summary.sourceHash,
				});
			} else if (mutation.kind === "archive_corrupt")
				this.ctx.storage.sql.exec(
					"UPDATE historical_custody_parts SET chunk_hash=? WHERE kind='source' AND part=0",
					"f".repeat(64),
				);
			else if (mutation.kind === "tenant")
				this.ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
					JSON.stringify(mutation.value),
				);
			else if (mutation.kind === "registry")
				this.ctx.storage.sql.exec(String(mutation.value));
			else this.ctx.storage.kv.put(mutation.kind, mutation.value);
		}
		const table = (name: string) =>
			this.ctx.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE name=?", name)
				.toArray().length
				? this.ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray()
				: [];
		return JSON.stringify({
			id: this.ctx.id.toString(),
			workflows: table("cf_agents_workflows"),
			state: table("cf_agents_state"),
			claims: table("runtime_admission_turns"),
			identities: table("runtime_admission_identities"),
			admission: table("runtime_admission"),
			registry: table("cf_agents_sub_agents"),
			observations: [
				...this.ctx.storage.kv.list({
					prefix: "runtime-workflow-observation:",
				}),
			],
			original: this.ctx.storage.kv.get("think-accounting:original"),
			starts: this.ctx.storage.kv.get("fixture:starts"),
			path: this.ctx.storage.kv.get("cf_agents_parent_path"),
			facetName: this.ctx.storage.kv.get("cf_agents_facet_name"),
			verified: this.ctx.storage.kv.get("fixture:claim-verified"),
		});
	}
}
export class AgentTediDO extends Agent<Cloudflare.Env, Owner> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		if (ctx.storage.kv.get("fixture:raw") === true)
			return new RawCutoverDO(ctx, env) as unknown as AgentTediDO;
		super(ctx, env);
	}
	// The binding's declared prototype advertises actual constructor-selected Raw RPCs.
	override async _cf_invokeAgentPath(
		path: unknown,
		method: unknown,
		args: unknown,
	) {
		return await ProductionRaw.prototype._cf_invokeAgentPath.call(
			this as unknown as ProductionRaw,
			path,
			method,
			args,
		);
	}
	async attempt(
		_path: unknown,
		_method: unknown,
		_args: unknown,
	): Promise<string> {
		throw Error("Raw only");
	}
	async warmOriginal(_path: string[]): Promise<number> {
		throw Error("Raw only");
	}
	async witness(
		_path: string[],
		_mutation?: { kind: string; value: unknown },
	): Promise<string> {
		throw Error("actual Raw witness required");
	}
	async freezeRoot(): Promise<unknown> {
		throw Error("Raw only");
	}
	async historical(
		_command: string,
		_generation: number,
		_sourceHash?: string,
	): Promise<{ status: number; body: string }> {
		throw Error("Raw only");
	}

	async rootAttempt(_input: unknown): Promise<string> {
		throw Error("Raw only");
	}
	async seedRoot(owner: Owner, mode: string) {
		this.setState(owner);
		this.ctx.storage.kv.put("__ps_name", this.name);
		const admission = new RuntimeAdmissionDO(this.ctx.storage, {
			...owner,
			objectId: this.ctx.id.toString(),
		});
		admission.gate.initialize({
			operationId: "fixture-active-root",
			state: "active",
			evidence: await admission.prepareEvidence("initialize"),
		});
		await admission.beginAcceptedTurn({
			runId: "original-run",
			sessionKey: "original-session",
			principalId: "original-principal",
			input: { text: "PRIVATE original root input" },
			expectedGeneration: 1,
		});
		const workflowId = await this.runWorkflow(
			"CHAT_TURN_WORKFLOW",
			{ mode },
			{
				id: "original-root-" + crypto.randomUUID(),
				agentBinding: "TEDI_AGENT",
			},
		);
		this.ctx.storage.kv.put("runtime-admission-workflow:original-run", {
			id: workflowId,
			stage: "dispatched",
			params: { runId: "original-run", sessionKey: "original-session" },
		});
		admission.gate.quarantine({
			operationId: "fixture-original-root-quarantine",
			expectedGeneration: 1,
			reason: "fixture",
		});
		this.ctx.storage.kv.put("fixture:raw", true);
		return { rootId: this.ctx.id.toString(), name: this.name, workflowId };
	}

	async seed(owner: Owner, native = false, mode = "complete") {
		this.setState(owner);
		this.ctx.storage.kv.put("__ps_name", this.name);
		const child = await this.subAgent(LegacyChild, "original");
		await child.seed(owner, false, true);
		const nested = await child.dispatch(owner, native, mode);
		new RuntimeAdmissionDO(this.ctx.storage, {
			...owner,
			objectId: this.ctx.id.toString(),
		}).gate.initialize({
			operationId: "fixture-root-quarantine",
			state: "quarantined",
			reason: "fixture",
		});
		this.ctx.storage.kv.put("fixture:raw", true);
		return { rootId: this.ctx.id.toString(), name: this.name, ...nested };
	}
}
export class LegacyChild extends Agent<Cloudflare.Env, { aigMetadata: Owner }> {
	async startCount() {
		return this.ctx.storage.kv.get<number>("fixture:starts") ?? 0;
	}
	async onStart() {
		this.ctx.storage.kv.put(
			"fixture:starts",
			(this.ctx.storage.kv.get<number>("fixture:starts") ?? 0) + 1,
		);
	}
	async seed(owner: Owner, native = false, nested = false) {
		this.setState({ aigMetadata: owner });
		if (nested) {
			const child = await this.subAgent(LegacyChild, "nested");
			await child.seed(owner, native);
			new RuntimeAdmissionDO(this.ctx.storage, {
				...owner,
				objectId: this.ctx.id.toString(),
			}).gate.initialize({
				operationId: "fixture-intermediate",
				state: "quarantined",
				reason: "fixture",
			});
		}
	}
	async dispatch(
		owner: Owner,
		native: boolean,
		mode: string,
	): Promise<{
		workflowId: string;
		path: Array<{ className: string; name: string }>;
		leafId: string;
	}> {
		if (this.name === "original")
			return await (
				await this.subAgent(LegacyChild, "nested")
			).dispatch(owner, native, mode);
		const admission = new RuntimeAdmissionDO(
			this.ctx.storage,
			{ ...owner, objectId: this.ctx.id.toString() },
			{
				parentPath: [...this.parentPath],
				facetName: this.name,
				identityName: this.ctx.id.name ?? this.name,
				objectId: this.ctx.id.toString(),
			},
		);
		if (native) {
			admission.gate.initialize({
				operationId: "fixture-active",
				state: "active",
				evidence: await admission.prepareEvidence("initialize"),
			});
			await admission.beginAcceptedTurn({
				runId: "original-run",
				sessionKey: "original-session",
				principalId: "original-principal",
				input: { text: "PRIVATE original input" },
				expectedGeneration: 1,
			});
		}
		const workflowId = await this.runWorkflow(
			"CHAT_TURN_WORKFLOW",
			{ mode },
			{ id: "original-" + crypto.randomUUID(), agentBinding: "TEDI_AGENT" },
		);
		if (native) {
			this.ctx.storage.kv.put("runtime-admission-workflow:original-run", {
				id: workflowId,
				stage: "dispatched",
				params: { runId: "original-run", sessionKey: "original-session" },
			});
			admission.gate.quarantine({
				operationId: "fixture-leaf-quarantine",
				expectedGeneration: 1,
				reason: "fixture",
			});
		} else
			admission.gate.initialize({
				operationId: "fixture-leaf-quarantine",
				state: "quarantined",
				reason: "fixture",
			});
		this.ctx.storage.kv.put("think-accounting:original", {
			status: "UNKNOWN",
			reservationId: "original-reservation",
			amount: null,
		});
		return {
			workflowId,
			path: [...this.selfPath],
			leafId: this.ctx.id.toString(),
		};
	}
}
export class OriginalCallbackWorkflow extends AgentWorkflow<
	AgentTediDO,
	{ mode: string },
	{},
	Cloudflare.Env
> {
	async run(event: WorkflowEvent<{ mode: string }>, step: AgentWorkflowStep) {
		await step.waitForEvent("original-ready", { type: "finish" });
		if (event.payload.mode === "error")
			await step.reportError("PRIVATE original error");
		else await step.reportComplete({ text: "PRIVATE original output" });
		return "reported";
	}
}
export default {
	fetch() {
		return new Response("fixture");
	},
};
