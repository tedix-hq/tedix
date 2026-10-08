import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { createDbClient } from "@tedix/db/client";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	listPendingTediWorkApprovals,
	type PendingTediWorkApproval,
} from "@tedix/db/queries/work-items/approvals";

/**
 * A held Home delegation review authorizes exactly one dispatch. Saying so in
 * the wake keeps the approver from reading its decision as a standing grant.
 */
function homeDelegationWakeScope(proposal: Record<string, unknown>): string {
	return proposal.kind === "home_delegation"
		? " Approving this home_delegation proposal authorizes this one dispatch only; it is not an entrustment, a standing grant, or a promotion of the target tedi."
		: "";
}

export function buildWorkApprovalWakeRequest(input: {
	candidate: PendingTediWorkApproval;
	tediSlug: string;
	domain: "tedix.dev" | "tedix.tech";
	nowMs?: number;
}): Request {
	const { candidate } = input;
	// A terminal failed Tedi workflow is immutable. Rotate its idempotency key
	// on a bounded window so redrive can recover, while deduplicating retries
	// within that window. The proposal decision remains a server-side CAS.
	const retryEpoch = Math.floor((input.nowMs ?? Date.now()) / 600_000);
	const deliveryKey = `work-approval:${candidate.id}:v${candidate.version}:e${retryEpoch}`;
	const text = `Act now as the designated independent approval tedi. Decide exactly one pending Work admission proposal. This is an execution request, not an advisory question. Use the native list_work_approval_inbox and decide_work_approval tools supplied to this runtime; they are identity-bound native tools, not Code Mode namespace callables. Call list_work_approval_inbox({proposalId:"${candidate.id}",limit:1}) and read proposal ${candidate.id} from your Work approval inbox and verify it matches Work Item ${candidate.workItemId} version ${candidate.workItemVersion}, authority ${candidate.authorityKey}, requester ${candidate.requesterType}:${candidate.requesterId}, and this server-delivered proposal: ${JSON.stringify(candidate.proposal)}. Read the returned canonical workItem description, acceptanceContract, riskLevel, requiredCapabilities, requiredAuthorities, and admissionSpecification resources/budget. Require both workItem.version and admissionSpecification.workItemVersion to match proposal.workItemVersion; if they do not, do not approve the stale proposal. Use these returned records, not the requester text alone, to independently assess whether the bounded scope and rationale justify admission. Then directly call decide_work_approval({proposalId:"${candidate.id}",expectedProposalVersion:${candidate.version},decision:"approved"|"rejected",rationale:"<specific independent rationale>"}). Do not use discovery for these known native tools. Do not ask a human, do not approve by default, do not change the proposal, and do not decide any other inbox row.${homeDelegationWakeScope(candidate.proposal)} Invoke the tools now.`;
	return new Request("https://tedi/hooks/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Tedix-Host": `${input.tediSlug}.tedi.${input.domain}`,
			"X-Service-Binding": "true",
			// The runtime fails closed on a missing tier; the wake carries
			// `metadata` the approver turn must keep.
			[CALLER_TRUST_HEADER]: "member",
		},
		body: JSON.stringify({
			session_key: deliveryKey,
			client_request_id: deliveryKey,
			async: true,
			metadata: {
				source: "work_approval_redrive",
				proposalId: candidate.id,
			},
			text,
		}),
	});
}

export function buildWorkApprovalCapabilityRequest(input: {
	tediSlug: string;
	domain: "tedix.dev" | "tedix.tech";
}): Request {
	return new Request("https://tedi/hooks/review-capabilities", {
		method: "GET",
		headers: {
			"X-Tedix-Host": `${input.tediSlug}.tedi.${input.domain}`,
			"X-Service-Binding": "true",
		},
	});
}

export async function assertWorkApprovalCapabilities(
	response: Response,
): Promise<void> {
	if (!response.ok) {
		throw new Error(
			`Work approval capability preflight failed with HTTP ${response.status}`,
		);
	}
	const body = (await response.json()) as { nativeTools?: string[] };
	const nativeTools = new Set(body.nativeTools ?? []);
	const missing = ["list_work_approval_inbox", "decide_work_approval"].filter(
		(tool) => !nativeTools.has(tool),
	);
	if (missing.length > 0) {
		throw new Error(
			`Designated approval tedi lacks native capabilities: ${missing.join(", ")}`,
		);
	}
}

export async function assertWorkApprovalWakeAccepted(
	response: Response,
): Promise<{ runId: string }> {
	if (response.ok) {
		const body = (await response.json()) as {
			accepted?: boolean;
			ok?: boolean;
			run_id?: string;
		};
		// 202 `accepted` queues a new turn; 200 `ok` is the settled receipt the
		// runtime replays when this epoch's wake already ran to completion.
		if ((body.accepted === true || body.ok === true) && body.run_id?.trim()) {
			return { runId: body.run_id.trim() };
		}
		throw new Error(
			"Ambiguous work approval wake acceptance: expected accepted=true or a settled receipt with a durable run_id",
		);
	}
	const detail = (await response.text()).slice(0, 500);
	throw new Error(
		`Tedi work approval wake failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
	);
}

export async function wakePendingWorkApproval(
	env: CloudflareEnv,
	db: ReturnType<typeof createDbClient>,
	candidate: PendingTediWorkApproval,
	nowMs = Date.now(),
): Promise<boolean> {
	if (Date.parse(candidate.expiresAt) <= nowMs) return false;
	const tedi = await getTediByIdForOrganization(
		db,
		candidate.approverId,
		candidate.orgId,
	);
	if (!tedi?.slug || tedi.status !== "active" || !env.TEDI_SERVICE)
		return false;
	const domain = env.ENVIRONMENT === "production" ? "tedix.dev" : "tedix.tech";
	await assertWorkApprovalCapabilities(
		await env.TEDI_SERVICE.fetch(
			buildWorkApprovalCapabilityRequest({ tediSlug: tedi.slug, domain }),
		),
	);
	const response = await env.TEDI_SERVICE.fetch(
		buildWorkApprovalWakeRequest({
			candidate,
			tediSlug: tedi.slug,
			domain,
			nowMs,
		}),
	);
	await assertWorkApprovalWakeAccepted(response);
	return true;
}

export async function dispatchWorkApprovalRedrives(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB);
	const observedAt = new Date(scheduledTime).toISOString();
	const candidates = await listPendingTediWorkApprovals(db, {
		observedAt,
		limit: 50,
	});
	let dispatched = 0;
	let deferred = 0;
	for (const candidate of candidates) {
		try {
			if (await wakePendingWorkApproval(env, db, candidate, scheduledTime))
				dispatched++;
			else deferred++;
		} catch (error) {
			console.error("[work-approval-redrive] wake failed", error);
			deferred++;
		}
	}
	return { observed: candidates.length, dispatched, deferred };
}
