import { createHash } from "node:crypto";
import { z } from "zod";
import { secureEqual } from "@tedix/worker-kit/request-auth";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
	type FacetAdmissionCustody,
} from "./runtime-admission-do";
import type { AdmissionSnapshot } from "./runtime-admission";
// Namespace RPC is local callback provenance, never provider attestation.
export const RetainedWorkflowCallback = z.discriminatedUnion("type", [
	z.strictObject({
		workflowName: z.literal("CHAT_TURN_WORKFLOW"),
		workflowId: z.string().min(1),
		type: z.literal("complete"),
		result: z.json().optional(),
		timestamp: z.number().int().nonnegative().safe(),
	}),
	z.strictObject({
		workflowName: z.literal("CHAT_TURN_WORKFLOW"),
		workflowId: z.string().min(1),
		type: z.literal("error"),
		error: z.string(),
		timestamp: z.number().int().nonnegative().safe(),
	}),
]);
export function observationCanonical(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v !== null && typeof v === "object")
			return Object.fromEntries(
				Object.keys(v)
					.sort()
					.map((key) => [key, sort((v as Record<string, unknown>)[key])]),
			);
		return v;
	};
	return JSON.stringify(sort(value));
}
function observationHash(value: unknown): string {
	return createHash("sha256").update(observationCanonical(value)).digest("hex");
}

interface ObservationFacts {
	admission: AdmissionSnapshot;
	state: string;
	name: string;
}
export interface ObservationCustody {
	facts: () => ObservationFacts;
	verify: (recheck: () => void) => Promise<void>;
	facet?: FacetAdmissionCustody;
}
/** Shared original ledger semantics for root and exact retained descendants. No SDK handler runs. */
export async function observeRetainedWorkflow(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	input: unknown,
	custody: ObservationCustody,
): Promise<void> {
	const callback = RetainedWorkflowCallback.parse(input);
	const capture = () => {
		const root = custody.facts();
		const rows = ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM cf_agents_workflows WHERE workflow_id=?",
				callback.workflowId,
			)
			.toArray();
		let row = rows[0];
		if (rows.length === 0) {
			// An immutable original row permits an observation, never SDK recovery.
			// Partial deletion or a resurrected tracking set is not this path.
			if (
				ctx.storage.sql
					.exec("SELECT id FROM cf_agents_workflows LIMIT 1")
					.toArray().length !== 0
			)
				throw new Error("retained callback tracking conflict");
			const archive = new HistoricalLiabilityCustody(
				ctx.storage,
				ctx.id.toString(),
			);
			const snapshot = archive.audit();
			if (!snapshot) throw new Error("retained callback archive unavailable");
			row =
				archive.retainedWorkflowRow({
					expectedGeneration: root.admission.generation,
					snapshotId: snapshot.snapshotId,
					sourceHash: snapshot.sourceHash,
					workflowId: callback.workflowId,
					binding: callback.workflowName,
				}) ?? undefined;
		}
		if (rows.length > 1 || !row || row.workflow_name !== callback.workflowName)
			throw new Error("retained callback workflow unavailable");
		const journals = [
			...ctx.storage.kv.list({
				prefix: "runtime-admission-workflow:",
			}),
		].filter(
			([, value]) =>
				value &&
				typeof value === "object" &&
				(value as Record<string, unknown>).id === callback.workflowId,
		);
		if (journals.length > 1)
			throw new Error("retained callback ambiguous provenance");
		const originalClaims = journals.map(([, value]) => {
			const runId = z
				.object({ params: z.object({ runId: z.string().min(1) }) })
				.parse(value).params.runId;
			return {
				identities: ctx.storage.sql
					.exec(
						"SELECT record,input FROM runtime_admission_identities WHERE run_id=?",
						runId,
					)
					.toArray(),
				claims: ctx.storage.sql
					.exec("SELECT record FROM runtime_admission_turns WHERE id=?", runId)
					.toArray(),
			};
		});
		return { root, row, journals, originalClaims };
	};
	const original = capture(),
		snapshot = observationCanonical(original);
	const recheck = () => {
		if (observationCanonical(capture()) !== snapshot)
			throw new Error("retained callback source changed");
	};
	recheck();
	await custody.verify(recheck);
	recheck();
	let provenance: unknown = {
		kind: "unknown",
		nativeDispatch: "absent",
		qualified: false,
	};
	if (original.journals.length) {
		const [key, value] = original.journals[0]!;
		const journal = z
			.object({
				id: z.literal(callback.workflowId),
				stage: z.enum(["dispatching", "dispatched", "uncertain"]),
				params: z
					.object({
						runId: z.string().min(1),
						sessionKey: z.string().min(1),
					})
					.passthrough(),
			})
			.strict()
			.parse(value);
		if (key !== `runtime-admission-workflow:${journal.params.runId}`)
			throw new Error("retained callback dispatch mismatch");
		const helper = new RuntimeAdmissionDO(
			ctx.storage,
			original.root.admission.owner,
			custody.facet,
		);
		const accepted = await helper.assertOriginalClaim({
			runId: journal.params.runId,
			sessionKey: journal.params.sessionKey,
		});
		recheck();
		provenance = {
			kind: "stored_native_dispatch",
			qualified: false,
			accepted,
			journalHash: observationHash(value),
		};
	}
	// Original-claim verification may await hashing. Observe canonical D1 last,
	// then keep the local source check and observation persistence synchronous.
	await custody.verify(recheck);
	recheck();
	const payload =
		callback.type === "complete"
			? callback.result === undefined
				? { type: callback.type, resultPresence: "absent" }
				: {
						type: callback.type,
						resultPresence: "present",
						result: callback.result,
					}
			: { type: callback.type, error: callback.error };
	const payloadHash = observationHash(payload),
		identity = observationHash([callback.workflowName, callback.workflowId]);
	const key = `runtime-workflow-observation:v1:${identity}:${callback.type === "complete" ? "complete" : payloadHash}`;
	const prior = ctx.storage.kv.get<Record<string, unknown>>(key);
	if (prior !== undefined) {
		if (!prior || typeof prior !== "object" || Array.isArray(prior))
			throw new Error("retained callback record malformed");
		const { recordHash, ...retained } = prior;
		if (
			typeof recordHash !== "string" ||
			recordHash !== observationHash(retained) ||
			prior.payloadHash !== payloadHash ||
			prior.workflowId !== callback.workflowId ||
			prior.workflowName !== callback.workflowName ||
			prior.version !== 1 ||
			prior.kind !== "unqualified_namespace_rpc_observation" ||
			prior.providerAttested !== false ||
			prior.sourceRowHash !== observationHash(original.row) ||
			observationHash(prior.payload) !== payloadHash ||
			prior.objectName !== original.root.name ||
			observationCanonical(prior.owner) !==
				observationCanonical(original.root.admission.owner)
		)
			throw new Error("retained callback completion conflict");
		return;
	}
	recheck();
	const record = {
		version: 1,
		kind: "unqualified_namespace_rpc_observation",
		providerAttested: false,
		objectName: original.root.name,
		custodyHash: observationHash(original.root),
		owner: { ...original.root.admission.owner },
		admission: original.root.admission,
		workflowName: callback.workflowName,
		workflowId: callback.workflowId,
		payloadHash,
		payload,
		reportedTimestamp: callback.timestamp,
		observedAt: Date.now(),
		sourceRowHash: observationHash(original.row),
		provenance,
	};
	ctx.storage.kv.put(key, {
		...record,
		recordHash: observationHash(record),
	});
}

const PathPart = z.strictObject({
	className: z.string().min(1),
	name: z.string().min(1),
});
const OriginPath = z.array(PathPart).min(2).max(17);
const PhysicalHop = z.strictObject({
	className: z.string().min(1),
	name: z.string().min(1),
	identityName: z.string().min(1),
	objectId: z.string().regex(/^[a-f0-9]{64}$/),
});
const Relay = z.strictObject({
	token: z.string(),
	path: OriginPath,
	index: z.number().int().positive().max(16),
	root: z.strictObject({
		objectId: z.string().regex(/^[a-f0-9]{64}$/),
		name: z.string().min(1),
		tediId: z.string().min(1),
		orgId: z.string().min(1),
		generation: z.number().int().positive().safe(),
		currentName: z.string().min(1).optional(),
	}),
	current: PhysicalHop,
	callback: RetainedWorkflowCallback,
});
type RelayInput = z.infer<typeof Relay>;
type RootProof = RelayInput["root"];
const refused = () => new Error("Retained workflow observation rejected");
function localObservationFacts(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	path: z.infer<typeof OriginPath>,
	index: number,
	root: RootProof,
	current?: RelayInput["current"],
): ObservationFacts {
	const id = ctx.id.toString(),
		admission = readStoredRuntimeAdmission(ctx.storage, id);
	if (
		!admission ||
		!["held", "quarantined", "retired"].includes(admission.state) ||
		admission.owner.objectId !== id ||
		admission.owner.tediId !== root.tediId ||
		admission.owner.orgId !== root.orgId
	)
		throw refused();
	const storedName = ctx.storage.kv.get("__ps_name"),
		isFacet = ctx.storage.kv.get("cf_agents_is_facet"),
		parentPath = ctx.storage.kv.get("cf_agents_parent_path");
	if (index === 0) {
		if (
			id !== root.objectId ||
			admission.generation !== root.generation ||
			path[0]!.className !== "AgentTediDO" ||
			path[0]!.name !== root.name ||
			storedName !== root.name ||
			(ctx.id.name !== undefined && ctx.id.name !== root.name) ||
			(isFacet !== undefined && isFacet !== false) ||
			(parentPath !== undefined && observationCanonical(parentPath) !== "[]") ||
			env.TEDI_AGENT.idFromName(root.name).toString() !== id
		)
			throw refused();
	} else {
		if (
			!current ||
			current.objectId !== id ||
			current.className !== path[index]!.className ||
			current.name !== path[index]!.name ||
			(storedName !== undefined && storedName !== current.identityName) ||
			(ctx.id.name !== undefined && ctx.id.name !== current.identityName) ||
			isFacet !== true ||
			ctx.storage.kv.get("cf_agents_facet_name") !== current.name ||
			observationCanonical(parentPath) !==
				observationCanonical(path.slice(0, index)) ||
			env.TEDI_AGENT.idFromName(current.identityName).toString() !== id
		)
			throw refused();
	}
	const rows = ctx.storage.sql
		.exec<{ state: string }>(
			"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
		)
		.toArray();
	if (rows.length !== 1) throw refused();
	const state = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(rows[0]!.state)),
		owner = index
			? z.record(z.string(), z.unknown()).parse(state.aigMetadata)
			: state;
	if (owner.tediId !== root.tediId || owner.orgId !== root.orgId)
		throw refused();
	return {
		admission,
		state: rows[0]!.state,
		name: index ? current!.identityName : root.name,
	};
}
async function verifyCanonicalRoot(
	env: Cloudflare.Env,
	root: RootProof,
	recheck: () => void,
	storage?: DurableObjectStorage,
) {
	const { resolveTediRuntimeIdentity } =
		await import("@tedix/db/queries/tedi-runtime-bootstrap");
	recheck();
	const owner = await resolveTediRuntimeIdentity(env.DB, root.tediId, true);
	recheck();
	if (
		root.currentName !== undefined &&
		owner?.isolateAgentId !== root.currentName
	)
		throw refused();
	if (typeof owner?.isolateAgentId !== "string" || !owner.isolateAgentId)
		throw refused();
	root.currentName ??= owner.isolateAgentId;
	if (
		owner?.id !== root.tediId ||
		owner.orgId !== root.orgId ||
		env.TEDI_AGENT.idFromName(root.name).toString() !== root.objectId
	)
		throw refused();
	if (owner.isolateAgentId !== root.name) {
		const { verifyRetainedRootCustody } =
			await import("./retained-root-custody");
		recheck();
		await verifyRetainedRootCustody(
			env,
			{
				tediId: root.tediId,
				orgId: root.orgId,
				objectId: root.objectId,
				objectName: root.name,
				generation: root.generation,
				currentName: root.currentName,
			},
			recheck,
			storage,
		);
	}
}
/** The SDK sends only a root-first origin path, method and argument array; no invented token is required here. */
export async function invokeRetainedDescendantCallback(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	pathInput: unknown,
	method: unknown,
	args: unknown,
): Promise<void> {
	if (
		method !== "_workflow_handleCallback" ||
		!Array.isArray(args) ||
		args.length !== 1
	)
		throw refused();
	const path = OriginPath.parse(pathInput),
		callback = RetainedWorkflowCallback.parse(args[0]),
		admission = readStoredRuntimeAdmission(ctx.storage, ctx.id.toString());
	if (!admission?.owner.tediId || !admission.owner.orgId) throw refused();
	const root = {
		objectId: ctx.id.toString(),
		name: path[0]!.name,
		tediId: admission.owner.tediId,
		orgId: admission.owner.orgId,
		generation: admission.generation,
	};
	await walkRetainedCallback(ctx, env, path, 0, root, callback);
}
/** Private namespace context is ancestry issued by the gated canonical root, not provider attestation. */
export async function relayRetainedDescendantCallback(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	input: unknown,
): Promise<void> {
	const parsed = Relay.parse(input);
	if (!(await secureEqual(parsed.token, env.SECRETS_MASTER_KEY)))
		throw refused();
	await walkRetainedCallback(
		ctx,
		env,
		parsed.path,
		parsed.index,
		parsed.root,
		parsed.callback,
		parsed.current,
	);
}
async function walkRetainedCallback(
	ctx: DurableObjectState,
	env: Cloudflare.Env,
	path: z.infer<typeof OriginPath>,
	index: number,
	root: RootProof,
	callback: z.infer<typeof RetainedWorkflowCallback>,
	current?: RelayInput["current"],
): Promise<void> {
	if (index >= path.length) throw refused();
	const facts = () =>
			localObservationFacts(ctx, env, path, index, root, current),
		captured = observationCanonical(facts());
	const recheck = () => {
		if (observationCanonical(facts()) !== captured) throw refused();
	};
	if (index === path.length - 1) {
		await observeRetainedWorkflow(ctx, env, callback, {
			facts,
			verify: (check) => verifyCanonicalRoot(env, root, check),
			facet: {
				parentPath: path.slice(0, index),
				facetName: current!.name,
				identityName: current!.identityName,
				objectId: ctx.id.toString(),
			},
		});
		return;
	}
	const next = path[index + 1]!;
	const registry = () =>
		ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM cf_agents_sub_agents WHERE class=? AND name=?",
				next.className,
				next.name,
			)
			.toArray();
	const rows = registry();
	if (rows.length !== 1) throw refused();
	const row = rows[0]!;
	if (
		!(
			(row.identity_version === null && row.identity_name === null) ||
			(row.identity_version === "path-v2" &&
				typeof row.identity_name === "string" &&
				row.identity_name.length > 0)
		)
	)
		throw refused();
	const identityName =
		row.identity_name === null || row.identity_name === undefined
			? row.name
			: row.identity_name;
	if (
		typeof identityName !== "string" ||
		typeof row.name !== "string" ||
		row.name !== next.name ||
		row.class !== next.className ||
		(row.identity_version !== null &&
			row.identity_version !== undefined &&
			row.identity_version !== "path-v2")
	)
		throw refused();
	const registryHash = observationHash(rows),
		recheckRegistry = () => {
			recheck();
			if (observationHash(registry()) !== registryHash) throw refused();
		};
	await verifyCanonicalRoot(
		env,
		root,
		recheckRegistry,
		index === 0 ? ctx.storage : undefined,
	);
	recheckRegistry();
	const id = env.TEDI_AGENT.idFromName(identityName),
		native = ctx as DurableObjectState & {
			exports: Record<string, DurableObjectClass>;
		};
	const stub = ctx.facets.get<
		import("./pi-cutover-maintenance-do").RawCutoverDO
	>(`${next.className}\0${next.name}`, () => ({
		class: native.exports.RawCutoverDO!,
		id,
	}));
	try {
		await stub._retainedDescendantWorkflowObservation({
			token: env.SECRETS_MASTER_KEY,
			path,
			index: index + 1,
			root,
			current: { ...next, identityName, objectId: id.toString() },
			callback,
		});
		recheckRegistry();
	} finally {
		(stub as typeof stub & { [Symbol.dispose]?: () => void })[
			Symbol.dispose
		]?.();
	}
}
