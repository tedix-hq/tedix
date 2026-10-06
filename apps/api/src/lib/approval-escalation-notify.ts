/**
 * Approval-escalation notification — the human-facing exit from the blocked
 * descendant ladder.
 *
 * Before this module the terminus of an escalation was the string `" · escalated"`
 * appended to a Home card that only renders when someone already has that
 * conversation open (apps/os/src/components/chat-cards.tsx). Nothing left the
 * process: no email, no webhook, not even a log line. A HIGH-urgency escalation
 * on an unattended conversation simply expired 24h later.
 *
 * This routes it through `sendOpsAlert` — the only production-wired push-to-human
 * transport callable from apps/api (Cloudflare `EMAIL` binding + the env-gated
 * webhook backstop), already live for the health and cost digests. KernelDO runs
 * inside apps/api, so `this.env` already carries both; no new binding, secret, or
 * vendor.
 *
 * The load-bearing rule: **a missing or unconfigured route is never a silent
 * no-op.** `sendOpsAlert` is deliberately silent when neither channel is
 * configured, so every outcome is made visible HERE instead:
 *
 *   - an `approval.escalated` audit row is written for every escalation, whether
 *     or not anything was delivered, carrying the channels that actually fired;
 *   - an unrouted or failed escalation additionally emits a structured
 *     `console.warn` carrying `signal: "approval.escalation.undelivered"`.
 *
 * "No route configured" and "route configured but delivery failed" stay
 * distinguishable, and neither is recorded as delivered.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "@tedix/db/client";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	getMemberByUserId,
	getMembersByOrganization,
} from "@tedix/db/queries/organization-members";
import { parseHomeToolWritePayload } from "../rpc/routers/kernel/write-executor";
import { sendOpsAlert } from "./ops-alert-egress";

/** Env slice the notifier needs — the same two channels the ops digests use. */
export interface ApprovalEscalationEnv {
	EMAIL?: SendEmail;
	HEALTH_ALERT_WEBHOOK?: string;
}

/** Where the recipient list came from, or why there is none. */
export type ApprovalRecipientSource =
	| "initiator"
	| "owners"
	| "admins"
	| "none";

/** Why nothing reached a human. Absent when at least one channel fired. */
export type ApprovalEscalationFailure =
	/** Neither an email recipient nor a webhook URL exists — nothing to send to. */
	| "no_route_configured"
	/** A route existed and every channel reported failure. */
	| "delivery_failed";

export interface ApprovalEscalationOutcome {
	approvalRequestId: string;
	/** The approval resolved between the alarm firing and this send. */
	skipped: boolean;
	delivered: boolean;
	/** Channels that actually fired, in `sendOpsAlert` terms. */
	channels: Array<"email" | "webhook">;
	recipientSource: ApprovalRecipientSource;
	recipientCount: number;
	failure?: ApprovalEscalationFailure;
}

export interface NotifyApprovalEscalationInput {
	organizationId: string;
	/**
	 * Rows THIS process latched to `escalated`, as returned by
	 * `escalateKernelApprovalMirrors`. The CAS-plus-`returning()` contract there
	 * is what makes this exactly-once — never pass a list read back separately.
	 */
	escalated: Array<{ id: string; approvalRequestId: string }>;
	escalatedAt: string;
}

interface ResolvedRecipients {
	emails: string[];
	source: ApprovalRecipientSource;
}

/**
 * Resolve who to page.
 *
 * Nothing on `tedi_approval_requests` names a person — the table has no
 * assignee/approver column. Two identities are derivable:
 *
 *  1. The initiator. For Home write approvals the *payload* carries
 *     `initiatedByUserId` (a Descope subject) — see `HomeToolWritePayload` in
 *     apps/api/src/rpc/routers/kernel/write-executor.ts, written at
 *     apps/api/src/rpc/routers/kernel/turn-work.ts. It is nested inside
 *     `payload`, never a top-level column, so it is read through the shared
 *     structural parser rather than an ad-hoc cast.
 *  2. Active owners, then active admins — the role class that can actually
 *     resolve the request (`AUTHZ.osApprove` on `tediApprovals.resolve`). This
 *     is the fallback and the only option for approval kinds with no initiator
 *     (workstation-attach, control-proposals).
 */
async function resolveRecipients(
	db: DbClient,
	organizationId: string,
	payload: unknown,
): Promise<ResolvedRecipients> {
	const write = parseHomeToolWritePayload(payload);
	if (write?.initiatedByUserId) {
		const member = await getMemberByUserId(
			db,
			organizationId,
			write.initiatedByUserId,
		);
		if (member?.status === "active" && member.email) {
			return { emails: [member.email], source: "initiator" };
		}
	}

	for (const role of ["owner", "admin"] as const) {
		const members = await getMembersByOrganization(db, organizationId, {
			role,
			status: "active",
		});
		const emails = [
			...new Set(members.map((m) => m.email).filter((e) => e.length > 0)),
		];
		if (emails.length > 0) {
			return { emails, source: role === "owner" ? "owners" : "admins" };
		}
	}

	return { emails: [], source: "none" };
}

function escalationBody(input: {
	organizationId: string;
	approvalRequestId: string;
	description: string;
	actionType: string;
	createdAt: string;
	expiresAt: string;
	escalatedAt: string;
}): string {
	return [
		`A tedi has been blocked waiting for approval and the request has escalated.`,
		"",
		`Action:    ${input.actionType}`,
		`Request:   ${input.description}`,
		`Approval:  ${input.approvalRequestId}`,
		`Org:       ${input.organizationId}`,
		`Requested: ${input.createdAt}`,
		`Escalated: ${input.escalatedAt}`,
		`Expires:   ${input.expiresAt}`,
		"",
		"Resolve it from Home (the approval card) or via the approvals API.",
	].join("\n");
}

/**
 * Notify a human for each escalation this process latched. Never throws — an
 * egress failure must not break the caller's remaining alarm work.
 */
export async function notifyApprovalEscalation(
	env: ApprovalEscalationEnv,
	db: DbClient,
	input: NotifyApprovalEscalationInput,
): Promise<ApprovalEscalationOutcome[]> {
	const outcomes: ApprovalEscalationOutcome[] = [];

	for (const mirror of input.escalated) {
		try {
			outcomes.push(await notifyOne(env, db, input, mirror));
		} catch (error) {
			// A single failed page must not drop the rest of the batch, and the
			// failure itself has to be visible rather than swallowed.
			console.warn(
				JSON.stringify({
					signal: "approval.escalation.undelivered",
					organizationId: input.organizationId,
					approvalRequestId: mirror.approvalRequestId,
					reason: "delivery_failed",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			outcomes.push({
				approvalRequestId: mirror.approvalRequestId,
				skipped: false,
				delivered: false,
				channels: [],
				recipientSource: "none",
				recipientCount: 0,
				failure: "delivery_failed",
			});
		}
	}

	return outcomes;
}

async function notifyOne(
	env: ApprovalEscalationEnv,
	db: DbClient,
	input: NotifyApprovalEscalationInput,
	mirror: { id: string; approvalRequestId: string },
): Promise<ApprovalEscalationOutcome> {
	const approval = await getApprovalRequestById(db, mirror.approvalRequestId);

	// The human may have resolved it between the alarm firing and this send.
	// Paging then would be a false alarm, and it is not an undelivered route —
	// the mirror row's `escalated` status already records that it escalated.
	if (!approval || approval.status !== "pending") {
		return {
			approvalRequestId: mirror.approvalRequestId,
			skipped: true,
			delivered: false,
			channels: [],
			recipientSource: "none",
			recipientCount: 0,
		};
	}

	const { emails, source } = await resolveRecipients(
		db,
		input.organizationId,
		approval.payload,
	);
	const webhookUrl = env.HEALTH_ALERT_WEBHOOK?.trim() ?? "";
	const text = escalationBody({
		organizationId: input.organizationId,
		approvalRequestId: approval.id,
		description: approval.description,
		actionType: approval.actionType,
		createdAt: approval.createdAt,
		expiresAt: approval.expiresAt,
		escalatedAt: input.escalatedAt,
	});

	const result =
		emails.length === 0 && webhookUrl.length === 0
			? { emailed: false, webhookPosted: false }
			: await sendOpsAlert(env, {
					subject: `[Tedix] Approval escalated: ${approval.description}`,
					text,
					emailRecipients: emails.join(","),
					webhookUrl,
					fromName: "Tedix Approvals",
					meta: {
						kind: "approval.escalated",
						organizationId: input.organizationId,
						approvalRequestId: approval.id,
						mirrorId: mirror.id,
						actionType: approval.actionType,
						escalatedAt: input.escalatedAt,
					},
				});

	const channels: Array<"email" | "webhook"> = [];
	if (result.emailed) channels.push("email");
	if (result.webhookPosted) channels.push("webhook");
	const delivered = channels.length > 0;
	const failure: ApprovalEscalationFailure | undefined = delivered
		? undefined
		: emails.length === 0 && webhookUrl.length === 0
			? "no_route_configured"
			: "delivery_failed";

	// Recorded for EVERY escalation, delivered or not. `channels` is exactly what
	// `sendOpsAlert` reported firing, so the row never claims a delivery that did
	// not happen. Deterministic id + onConflictDoNothing keeps a retried alarm
	// from writing a second evidence row.
	await insertAuditEvent(db, {
		id: `approval-escalation:${mirror.id}`,
		organizationId: input.organizationId,
		actorId: "kernel",
		actorType: "kernel",
		action: "approval.escalated",
		resourceType: "approval_request",
		resourceId: approval.id,
		metadata: {
			source: "kernelDO.processBlockedDescendantAlarm",
			mirrorId: mirror.id,
			actionType: approval.actionType,
			escalatedAt: input.escalatedAt,
			notification: {
				delivered,
				channels,
				recipientSource: source,
				recipientCount: emails.length,
				webhookConfigured: webhookUrl.length > 0,
				...(failure ? { failure } : {}),
			} satisfies Record<string, JsonValue>,
		},
		ignoreDuplicates: true,
	});

	if (!delivered) {
		// sendOpsAlert is silent by design when unconfigured; make the no-route and
		// broken-route cases loud at the call site that actually owns the promise.
		console.warn(
			JSON.stringify({
				signal: "approval.escalation.undelivered",
				organizationId: input.organizationId,
				approvalRequestId: approval.id,
				mirrorId: mirror.id,
				recipientSource: source,
				recipientCount: emails.length,
				webhookConfigured: webhookUrl.length > 0,
				reason: failure,
			}),
		);
	}

	return {
		approvalRequestId: approval.id,
		skipped: false,
		delivered,
		channels,
		recipientSource: source,
		recipientCount: emails.length,
		...(failure ? { failure } : {}),
	};
}
