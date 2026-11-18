import { appEditRequestFrom } from "@/lib/app-edit-approval";
import type {
	ApprovalNotice,
	ApprovalRun,
	ChatApproval,
	WaitingApproval,
} from "@/lib/workspace-chat-state";
import type { ApprovalDecision } from "@/lib/workspace-chat-protocol";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";

/** The item a proposal is for, when it names one. */
export function approvalTarget(approval: ChatApproval): string | null {
	if (approval.target?.title) return approval.target.title;
	const input = approval.input;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const title = (input as Record<string, unknown>).title;
		if (typeof title === "string" && title.trim()) return title;
		// A new app is named, not titled.
		const name = (input as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim()) return name;
	}
	return null;
}

/** One line for a request: "Editing document blocks: Plan". */
export function approvalLine(approval: ChatApproval): string {
	const target = approvalTarget(approval);
	return `${approvalTitle(approval)}${target ? `: ${target}` : ""}`;
}

/** The requests waiting on one thing: a file, an app, a site. */
export type ApprovalGroup = {
	/** Stable while the group has requests; names what is being changed. */
	key: string;
	title: string;
	/** Oldest first, the order they are approved in. */
	requests: WaitingApproval[];
	/** None of its requests was raised in the open chat. */
	askedElsewhere: boolean;
};

/**
 * What a request changes. An existing file or app is known by its id, so two
 * edits of one document share a group even after a rename; a web page by its
 * site; anything new by what it does and what it is called.
 */
function groupOf(approval: WaitingApproval): { key: string; title: string } {
	const page = webPageRequest(approval);
	if (page) return { key: `site:${page.site}`, title: page.site };
	if (approval.target)
		return { key: `file:${approval.target.id}`, title: approval.target.title };
	const edit = appEditRequestFrom(approval.input);
	const named = approvalTarget(approval);
	if (edit) return { key: `app:${edit.appId}`, title: named ?? approval.title };
	return named
		? { key: `new:${approval.title}:${named}`, title: named }
		: { key: `action:${approval.title}`, title: approval.title };
}

/**
 * Groups the workspace's waiting requests by what each one changes. The
 * groups the open chat asked for come first and the ones asked elsewhere
 * after them; within each, the group holding the oldest request leads.
 * `waiting` arrives oldest first and every group keeps that order.
 */
export function approvalGroups(
	waiting: readonly WaitingApproval[],
	conversationId: string | null,
): ApprovalGroup[] {
	const groups = new Map<string, ApprovalGroup>();
	for (const request of waiting) {
		const { key, title } = groupOf(request);
		const group = groups.get(key);
		const elsewhere = request.conversationId !== conversationId;
		if (group) {
			group.requests.push(request);
			group.askedElsewhere &&= elsewhere;
		} else
			groups.set(key, {
				key,
				title,
				requests: [request],
				askedElsewhere: elsewhere,
			});
	}
	const all = [...groups.values()];
	return [
		...all.filter((group) => !group.askedElsewhere),
		...all.filter((group) => group.askedElsewhere),
	];
}

/** How many requests were raised outside the open chat. */
export function askedElsewhereCount(
	waiting: readonly WaitingApproval[],
	conversationId: string | null,
): number {
	return waiting.filter((request) => request.conversationId !== conversationId)
		.length;
}

/**
 * The order a run decides requests in: approving goes oldest first, because
 * a later change may build on an earlier one; denying goes newest first, so
 * nothing is withdrawn from under a request that was written after it.
 */
export function approvalRunOrder(
	requests: readonly WaitingApproval[],
	decision: ApprovalDecision,
): string[] {
	const ids = requests.map((request) => request.approvalId);
	return decision === "approve" ? ids : ids.reverse();
}

/** "Approving 2 of 5…" while a run works through its requests. */
export function approvalRunProgress(
	run: ApprovalRun,
	waiting: readonly WaitingApproval[],
): string {
	const total = run.requests.length;
	const left = run.requests.filter((request) =>
		waiting.some((item) => item.approvalId === request.approvalId),
	).length;
	const current = Math.min(total - left + 1, total);
	return `${run.decision === "approve" ? "Approving" : "Denying"} ${current} of ${total}…`;
}

/** What a decision that did not go as asked tells the person. */
export function approvalNoticeText(notice: ApprovalNotice): string {
	if (notice.kind === "disconnected")
		return `The connection dropped before every answer came back. Check what is still waiting before you ${notice.decision === "approve" ? "approve" : "deny"} again.`;
	const name = notice.request
		? `“${approvalLine(notice.request)}”`
		: "One request";
	if (notice.kind === "already_decided")
		return `${name} was already decided by someone else.`;
	const approving = notice.decision === "approve";
	const why =
		notice.reason === "failed"
			? `${name} could not be applied${notice.error ? `: ${notice.error.trim().replace(/[.\s]+$/, "")}` : ""}.`
			: approving
				? `${name} was denied by someone else.`
				: `${name} was approved before it could be denied.`;
	if (notice.total === 1) return why;
	const rest = notice.total - notice.done - 1;
	return `${approving ? "Approved" : "Denied"} ${notice.done} of ${notice.total}. ${why}${rest > 0 ? " The rest are still waiting." : ""}`;
}
