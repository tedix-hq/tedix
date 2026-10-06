/**
 * Rationale bridge for tenant skill workflows.
 *
 * The tenant-loaded dispatch shim receives `__RATIONALE_BRIDGE__`, not
 * API_SERVICE or a bearer token. Identity (tediId/orgId/runId/skillId) and
 * rationale policy are attached as `ctx.props`, so tenant code cannot spoof
 * provenance by changing the payload.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import type { RationaleMode } from "@tedix/api-contract/utils/skill-manifest";
import { logSkillRuntimeWarning } from "./control-log";
import {
	buildWorkflowRationalePayload,
	RationaleEventSchema,
	type RationaleRecordInput,
	workflowRationaleIdempotencyKey,
} from "./rationale-payload";

export interface RationaleBridgeEnv {
	API_SERVICE?: Fetcher;
}

export interface RationaleBridgeProps {
	runId: string;
	skillId: string;
	skillSlug: string | null;
	tediId: string;
	orgId: string;
	rationaleMode: RationaleMode;
	executionEpoch: number;
	serviceToken: string;
}

async function recordRationale(
	env: RationaleBridgeEnv,
	props: RationaleBridgeProps,
	input: RationaleRecordInput,
): Promise<true> {
	const built = buildWorkflowRationalePayload(input);
	const idempotencyKey = await workflowRationaleIdempotencyKey({
		runId: props.runId,
		executionEpoch: props.executionEpoch,
		gate: input.gate,
		stepName: input.stepName,
		stepCount: input.stepCount,
		attempt: input.attempt,
	});
	const body = {
		tediId: input.tediId,
		orgId: input.orgId,
		idempotencyKey,
		action: built.action,
		rationale: built.rationale,
		category: built.category,
		confidence: built.confidence,
		evidence: built.evidence,
		...(built.outcomeStatus
			? { outcomeStatus: built.outcomeStatus, outcome: built.outcome }
			: {}),
	};

	if (!env.API_SERVICE) {
		// Local-dev or misconfigured env — log and accept so the dispatch
		// shim's fire-and-forget call doesn't repeatedly retry.
		logSkillRuntimeWarning("rationale.api_binding_missing", {
			runId: props.runId,
		});
		return true;
	}
	try {
		await callRpc("rationaleRecords/create", body, {
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": input.orgId,
				"X-Tedix-Tedi-Id": input.tediId,
				Authorization: `Bearer ${props.serviceToken}`,
			},
		});
	} catch (error) {
		throw new Error(
			`RATIONALE_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return true;
}

export class RationaleBridge extends WorkerEntrypoint<
	RationaleBridgeEnv,
	RationaleBridgeProps
> {
	async record(payload: unknown): Promise<true> {
		if (this.ctx.props.rationaleMode === "off") {
			return true;
		}
		const parsed = RationaleEventSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`RATIONALE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		return recordRationale(this.env, this.ctx.props, {
			runId: this.ctx.props.runId,
			skillId: this.ctx.props.skillId,
			skillSlug: this.ctx.props.skillSlug,
			tediId: this.ctx.props.tediId,
			orgId: this.ctx.props.orgId,
			...parsed.data,
		});
	}
}
