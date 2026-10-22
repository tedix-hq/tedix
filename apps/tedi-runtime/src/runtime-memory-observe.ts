import type { LlmChatParams, LlmClient } from "./brain/llm-client";
import { observerCompletion } from "./observer-llm";
import {
	inferenceOriginHash,
	type NativeRootProof,
	privateInferenceOriginGuard,
} from "./runtime-inference-origin";
import type { RuntimeMemoryHost } from "./runtime-memory";

/** Pins this local operation before billing; the transport invokes it synchronously at each wire. */
export function observerBeforeDispatch(
	this: RuntimeMemoryHost,
	admittedRunId?: string,
	cancellationRunId = admittedRunId,
): () => void {
	const owner = { tediId: this.state.tediId, orgId: this.state.orgId };
	const admission = this.runtimeAdmission();
	if (admission && !admittedRunId)
		throw new Error("Observer inference requires an accepted operation");
	const accepted = admission?.assertAcceptedTurnSync({
		runId: admittedRunId!,
	});
	const nativeIdentity = {
		objectId: this.ctx.id.toString(),
		objectName: this.name,
		path: inferenceOriginHash(this.selfPath),
	};
	const configuration = () => ({
		modelOverride: this.modelOverrideForSurface("observer") ?? null,
		deployment: this.observerDeploymentForTurn(),
		configGeneration: this.runtimeConfigCache.generation,
		modelPolicy: this.runtimeConfigCache.modelPolicy ?? null,
	});
	const configurationHash = inferenceOriginHash(configuration());
	const recheck = () => {
		if (
			this.ctx.id.toString() !== nativeIdentity.objectId ||
			this.name !== nativeIdentity.objectName ||
			inferenceOriginHash(this.selfPath) !== nativeIdentity.path
		)
			throw new Error(
				"Observer original native identity changed before dispatch",
			);
		if (inferenceOriginHash(configuration()) !== configurationHash)
			throw new Error("Observer configuration changed before dispatch");
		if (this.state.tediId !== owner.tediId || this.state.orgId !== owner.orgId)
			throw new Error("Observer owner changed before dispatch");
		const stored = this.ctx.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			)
			.toArray()[0];
		const storedOwner = stored
			? (JSON.parse(stored.state) as { tediId?: unknown; orgId?: unknown })
			: null;
		if (
			(admission && !storedOwner) ||
			(storedOwner &&
				(storedOwner.tediId !== owner.tediId ||
					storedOwner.orgId !== owner.orgId))
		)
			throw new Error("Observer stored owner changed before dispatch");
		const current = this.runtimeAdmission();
		if (Boolean(current) !== Boolean(admission))
			throw new Error("Observer admission selection changed before dispatch");
		if (current && accepted)
			current.assertAcceptedTurnSync({
				runId: accepted.runId,
				expected: accepted,
			});
		if (
			(admittedRunId && this.ctx.storage.kv.get(`wfcancel:${admittedRunId}`)) ||
			(cancellationRunId &&
				this.ctx.storage.kv.get(`wfcancel:${cancellationRunId}`))
		)
			throw new Error("Observer operation canceled before dispatch");
	};
	const root: NativeRootProof = {
		owner: { ...owner, objectId: this.ctx.id.toString() },
		objectName: this.name,
		className: "AgentTediDO",
		path: [],
		generation: accepted?.generation ?? 0,
		...(accepted ? { accepted } : {}),
	};
	const selected = {
		owner: root.owner,
		className: "AgentTediDO",
		generation: root.generation,
		identityName: root.objectName,
		facetName: null,
		path: [],
	};
	if (accepted) {
		const input = this.ctx.storage.sql
			.exec<{ input: string }>(
				"SELECT input FROM runtime_admission_identities WHERE run_id=?",
				accepted.runId,
			)
			.toArray()[0];
		return privateInferenceOriginGuard(
			{
				kind: "accepted_native",
				root: { ...root, accepted },
				selected: { ...selected, accepted },
				operation: null,
				configurationHash,
			},
			recheck,
			input?.input,
		);
	}
	// No operation or claim is fabricated for unselected original owners.
	return privateInferenceOriginGuard(
		{ kind: "unselected_native", root, selected, configurationHash },
		recheck,
	);
}

/**
 * `LlmClient` adapter for shared reflection using the Agent runtime's
 * configured observer model, gateway transport and inference authorization.
 */
export function getObserverLlmClient(
	this: RuntimeMemoryHost,
	admittedRunId?: string,
	cancellationRunId = admittedRunId,
): LlmClient {
	const beforeDispatch = this.observerBeforeDispatch(
		admittedRunId,
		cancellationRunId,
	);
	const env = this.env;
	const metadata = this.tediAigMetadata("observer:reflection");
	const modelRef = this.modelOverrideForSurface("observer")?.modelRef;
	const deployment = modelRef?.startsWith("azure-openai/")
		? this.observerDeploymentForTurn()
		: undefined;
	return {
		async chat(params: LlmChatParams) {
			beforeDispatch();
			return {
				content: await observerCompletion({
					beforeDispatch,
					env,
					metadata,
					modelRef,
					deployment,
					messages: params.messages,
					signal: params.signal,
					maxCompletionTokens: params.maxCompletionTokens ?? 2000,
				}),
			};
		},
	};
}
