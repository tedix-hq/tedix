/**
 * One model for every decision waiting on a person, shared by the Activity
 * popover and the Approvals page: Home holds and runtime requests become
 * `ApprovalListItem`s with plain titles, inputs and consequences, and
 * `useApprovalInbox` decides them and says what happened.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { useState } from "react";
import {
	type ApprovalCardData,
	approvalsForAuthority,
	approvalsFromRunSet,
	hasOsApprovalAuthority,
} from "@/components/chat-cards";
import { osApi, osChatMutationApi } from "@/lib/api";
import { appLabel, plainApprovalTitle } from "@/lib/approval-titles";
import {
	homeRunSetQueryOptions,
	operationalContextQueryOptions,
	osQueryKeys,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
	workPendingApprovalsQueryOptions,
} from "@/lib/os-query-options";
import { useTediNames } from "@/lib/use-tedi-names";
import {
	approvalAttentionCount,
	isDecidableWorkApproval,
} from "@/lib/work-counts";
import { workRefreshOptions } from "@/lib/work-refresh";

export function isActionableHomeApproval(approval: {
	decisionMode?: "approve_or_reject" | "no_action";
	expired?: boolean;
}): boolean {
	return (
		approval.expired !== true &&
		(approval.decisionMode ?? "approve_or_reject") === "approve_or_reject"
	);
}

type RuntimeApproval = NonNullable<
	Awaited<ReturnType<typeof osApi.tediApprovals.list>>["data"]
>[number];

type ChipTone = "secondary" | "warning" | "error";

/** One decision waiting on a person, whichever plane it belongs to. */
export type ApprovalListItem = {
	key: string;
	title: string;
	kind: string;
	tedi: { id: string; name: string } | null;
	/** The app the action would touch, when the request names one. */
	where: string | null;
	requestedAt: string | null;
	expiresAt: string | null;
	chip: { label: string; tone: ChipTone };
	/** The exact inputs that matter, as short "Label: value" parts. */
	details: string[];
	/** Plain-language consequence copy. */
	what: string;
	ifApproved: string;
	ifRejected: string;
	recommendation: "approved" | "rejected";
	recommendationReason: string;
	/** What happens next once a person approves, for the confirmation line. */
	afterApprove: string;
	technical: string | null;
	/** The exact stored request, for the technical details disclosure. */
	raw: unknown;
	conversationId: string | null;
	/** The runtime action type; null for Home holds. */
	actionType: string | null;
	target:
		| { plane: "home"; runId: string }
		| { plane: "runtime"; approvalId: string };
};

const RESERVED_CLASS_LABELS: Record<string, string> = {
	money: "Money",
	external_message: "Sends messages",
	public_publish: "Publishes",
	credentials: "Credentials",
	legal: "Legal",
	deletion: "Deletes data",
	delete_data: "Deletes data",
	access_change: "Access change",
	access_control: "Access change",
	production_settings: "Production settings",
};

/** The hold reason as a short chip: what kind of risk made Home stop. */
export function delegationHoldChip(reason: string | null | undefined): {
	label: string;
	tone: ChipTone;
} {
	const reserved = reason?.match(/^human-reserved:\s*(.+)$/);
	if (reserved?.[1]) {
		const classes = reserved[1].split(/\s*,\s*/).filter(Boolean);
		const first = classes[0] ?? "";
		const label =
			RESERVED_CLASS_LABELS[first] ??
			first.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
		return {
			label: classes.length > 1 ? `${label} +${classes.length - 1}` : label,
			tone: "warning",
		};
	}
	if (reason && /\bhigh risk\b/i.test(reason))
		return { label: "High risk", tone: "error" };
	return { label: "Needs review", tone: "secondary" };
}

const RUNTIME_INTENT_CHIPS: Record<string, { label: string; tone: ChipTone }> =
	{
		tool_write: { label: "Change", tone: "warning" },
		browser_takeover: { label: "Sign-in", tone: "secondary" },
		workstation_attach: { label: "Workstation", tone: "secondary" },
		runtime_permission: { label: "Permission", tone: "warning" },
	};

export function homeApprovalItem(approval: ApprovalCardData): ApprovalListItem {
	const decision = approvalDecision({
		actionType: "home_request",
		review: { intent: "home_request" },
	});
	const name = approval.tediName ?? null;
	return {
		key: approval.approvalId,
		title: plainApprovalTitle(approval.requestPreview ?? approval.summary),
		kind: approval.approvalId.startsWith("home-delegation:")
			? "Delegation"
			: "Home request",
		tedi: name ? { id: approval.tediId ?? name, name } : null,
		where: approval.appSlug ? appLabel(approval.appSlug) : null,
		requestedAt: approval.requestedAt ?? null,
		expiresAt: approval.expiresAt ?? null,
		chip: delegationHoldChip(approval.detail),
		details: [],
		what: decision.what,
		ifApproved: decision.ifApproved,
		ifRejected: decision.ifRejected,
		recommendation: decision.recommendation,
		recommendationReason: decision.reason,
		afterApprove: "Home continues.",
		technical: approval.detail ?? null,
		raw: approval.args ?? null,
		conversationId: null,
		actionType: null,
		target: { plane: "home", runId: approval.runId },
	};
}

function payloadText(payload: Record<string, unknown>, key: string) {
	const value = payload[key];
	return typeof value === "string" && value.trim() ? value : null;
}

export function runtimeApprovalItem(
	approval: RuntimeApproval,
	tediNames: Record<string, string>,
): ApprovalListItem {
	const decision = approvalDecision(approval);
	const name = tediNames[approval.tediId] ?? null;
	const payload = approval.payload as Record<string, unknown>;
	const toolCall = approval.actionType === "mcp.tool_call";
	const fullTitle = plainApprovalTitle(
		approval.review.summary || approval.description,
		approval.payload,
	);
	// "Create factory — name: X": the inputs after the dash are listed as
	// details, so the title keeps only the action.
	const title =
		decision.details.length > 0
			? fullTitle.replace(/\s+—\s+.*$/, "")
			: fullTitle;
	return {
		key: approval.id,
		title,
		kind: toolCall ? "Tool call" : "Action",
		tedi: name ? { id: approval.tediId, name } : null,
		where: appLabel(payloadText(payload, "appSlug")),
		requestedAt: approval.createdAt,
		expiresAt: approval.expiresAt,
		chip:
			payload.riskTier === "high"
				? { label: "High risk", tone: "error" }
				: (RUNTIME_INTENT_CHIPS[approval.review.intent] ?? {
						label: "Needs review",
						tone: "secondary",
					}),
		// A detail the title already states ("Create 1 Work item in X: "Task"")
		// is not repeated under it.
		details: decision.details.filter(
			(part) => !title.includes(part.replace(/^[^:]+:\s*/, "")),
		),
		what: decision.what,
		ifApproved: decision.ifApproved,
		ifRejected: decision.ifRejected,
		recommendation: decision.recommendation,
		recommendationReason: decision.reason,
		afterApprove: toolCall
			? "The caller can now run it once."
			: payload.kind === "home_tool_write"
				? "The change runs now."
				: "The tedi continues.",
		technical: approval.description,
		raw: {
			description: approval.description,
			payload: approval.payload,
			evidence: approval.review.evidenceRefs,
		},
		conversationId: payloadText(payload, "conversationId"),
		actionType: approval.actionType,
		target: { plane: "runtime", approvalId: approval.id },
	};
}

export function isActionableRuntimeApproval(approval: {
	review: { decisionMode: string; timeout: { expired: boolean } };
}): boolean {
	return (
		approval.review.decisionMode === "approve_or_reject" &&
		!approval.review.timeout.expired
	);
}

/** Rows grouped by the tedi they act for, largest group first. */
export function groupApprovalItems(
	items: readonly ApprovalListItem[],
): { label: string; items: ApprovalListItem[] }[] {
	const groups = new Map<string, ApprovalListItem[]>();
	for (const item of items) {
		const label = item.tedi?.name ?? "Tedix";
		groups.set(label, [...(groups.get(label) ?? []), item]);
	}
	return [...groups.entries()]
		.map(([label, grouped]) => ({ label, items: grouped }))
		.sort(
			(a, b) =>
				b.items.length - a.items.length || a.label.localeCompare(b.label),
		);
}

/**
 * Identical requests (same action, asked by the same tedi, for the same
 * reason) collapse into one row that is decided together. Old rows and rows
 * from both decision planes are covered, because this runs on what the OS
 * shows rather than on how the request was created.
 */
export function collapseIdenticalItems(
	items: readonly ApprovalListItem[],
): ApprovalListItem[][] {
	const rows = new Map<string, ApprovalListItem[]>();
	for (const item of items) {
		const key = [
			item.tedi?.id ?? "",
			item.kind,
			item.chip.label,
			item.where ?? "",
			item.title,
			item.details.join("\u0001"),
		].join("\u0000");
		rows.set(key, [...(rows.get(key) ?? []), item]);
	}
	return [...rows.values()];
}

/** Soonest expiry first; a request without a window goes last. */
export function bySoonestExpiry(
	a: { expiresAt: string | null },
	b: { expiresAt: string | null },
): number {
	const left = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
	const right = b.expiresAt
		? Date.parse(b.expiresAt)
		: Number.POSITIVE_INFINITY;
	return left - right;
}

export type ApprovalChoice = "approved" | "rejected" | "recommended";

/** The confirmation a person reads after a decision is recorded. */
export type ApprovalOutcome = {
	status: "approved" | "rejected";
	count: number;
	title: string;
	message: string;
};

export function approvalOutcome(
	row: readonly ApprovalListItem[],
	status: "approved" | "rejected",
): ApprovalOutcome {
	const item = row[0]!;
	const count = row.length;
	const subject = count > 1 ? `${count} requests: ${item.title}` : item.title;
	return {
		status,
		count,
		title: item.title,
		message:
			status === "approved"
				? `Approved: ${subject}. ${item.afterApprove}`
				: `Rejected: ${subject}. Nothing ran.`,
	};
}

/**
 * Everything waiting on the signed-in person, with one-call decisions.
 * `conversationId` adds the Home holds of the open conversation.
 */
export function useApprovalInbox({
	conversationId = null,
}: {
	conversationId?: string | null;
} = {}) {
	const queryClient = useQueryClient();
	const tediNames = useTediNames();
	const context = useQuery(operationalContextQueryOptions());
	const authority = context.data?.authority;
	const runSet = useQuery({
		...homeRunSetQueryOptions(conversationId ?? ""),
		enabled: conversationId !== null,
		...workRefreshOptions,
	});
	const runtime = useQuery({
		...pendingApprovalsQueryOptions(),
		...workRefreshOptions,
	});
	const workStart = useQuery({
		...workRefreshOptions,
		...workPendingApprovalsQueryOptions(),
	});
	const workStartPending = (workStart.data?.data ?? []).filter(
		isDecidableWorkApproval,
	);
	const pendingHome = useQuery({
		...pendingHomeDelegationsQueryOptions(),
		...workRefreshOptions,
	});
	const homeApprovals = runSet.data?.runSet
		? approvalsForAuthority(
				approvalsFromRunSet(runSet.data.runSet),
				authority,
			).filter(isActionableHomeApproval)
		: [];
	const globalHomeApprovals = pendingHome.data?.runSet
		? approvalsForAuthority(
				approvalsFromRunSet(pendingHome.data.runSet),
				authority,
			).filter(
				(approval) =>
					isActionableHomeApproval(approval) &&
					!homeApprovals.some(
						(current) => current.approvalId === approval.approvalId,
					),
			)
		: [];
	// A parked Home write is listed by both sources; show it once, as the
	// Home card that names the tool and arguments.
	const homeApprovalIds = new Set(
		[...homeApprovals, ...globalHomeApprovals].map((a) => a.approvalId),
	);
	const canDecide = hasOsApprovalAuthority(authority);
	const runtimeRows = (runtime.data?.data ?? []).filter(
		(approval) => canDecide && !homeApprovalIds.has(approval.id),
	);
	const runtimeApprovals = runtimeRows.filter(isActionableRuntimeApproval);
	const items = [
		...[...homeApprovals, ...globalHomeApprovals].map(homeApprovalItem),
		...runtimeApprovals.map((approval) =>
			runtimeApprovalItem(approval, tediNames),
		),
	].sort(bySoonestExpiry);
	const expired = runtimeRows
		.filter(
			(approval) =>
				approval.review.decisionMode === "approve_or_reject" &&
				approval.review.timeout.expired,
		)
		.map((approval) => runtimeApprovalItem(approval, tediNames));
	const count = approvalAttentionCount({
		home: homeApprovals.length + globalHomeApprovals.length,
		runtime: runtimeApprovals.length,
		work: workStartPending.length,
	});
	const runtimeTotal = runtime.data?.pagination?.total ?? 0;
	const runtimeShown = runtime.data?.data.length ?? 0;

	const respondHome = useMutation({
		mutationFn: ({
			runId,
			decision,
			delegateRecommendation,
		}: {
			runId: string;
			decision: "approve" | "reject";
			delegateRecommendation?: boolean;
		}) =>
			osChatMutationApi.kernelRuntime.respondApproval({
				runId,
				decision,
				delegateRecommendation,
			}),
	});
	const resolveRuntime = useMutation({
		mutationFn: ({
			id,
			status,
			delegateRecommendation,
		}: {
			id: string;
			status: "approved" | "rejected";
			delegateRecommendation?: boolean;
		}) =>
			osApi.tediApprovals.resolve({
				id,
				status,
				delegateRecommendation,
				resolution:
					status === "approved"
						? "Approved in Tedix OS after reading the request."
						: "Rejected in Tedix OS after reading the request.",
			}),
	});
	const clearExpired = useMutation({
		mutationFn: () => osApi.tediApprovals.clearExpired({}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.approvals() }),
	});
	const [pendingKeys, setPendingKeys] = useState<readonly string[]>([]);
	const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
	const [error, setError] = useState<unknown>(null);

	async function refresh() {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.approvals() }),
			queryClient.invalidateQueries({
				queryKey: pendingHomeDelegationsQueryOptions().queryKey,
			}),
			conversationId !== null
				? queryClient.invalidateQueries({
						queryKey: homeRunSetQueryOptions(conversationId).queryKey,
					})
				: null,
		]);
	}

	function decideOne(item: ApprovalListItem, choice: ApprovalChoice) {
		const status = choice === "recommended" ? item.recommendation : choice;
		const delegateRecommendation = choice === "recommended" || undefined;
		return item.target.plane === "home"
			? respondHome.mutateAsync({
					runId: item.target.runId,
					decision: status === "approved" ? "approve" : "reject",
					delegateRecommendation,
				})
			: resolveRuntime.mutateAsync({
					id: item.target.approvalId,
					status,
					delegateRecommendation,
				});
	}

	/**
	 * One decision for every request in `row`, in order. It stops at the first
	 * failure so the rest stay waiting rather than half-decided.
	 */
	async function decide(
		row: readonly ApprovalListItem[],
		choice: ApprovalChoice,
	): Promise<ApprovalOutcome | null> {
		if (row.length === 0) return null;
		const keys = row.map((item) => item.key);
		setPendingKeys((current) => [...current, ...keys]);
		setError(null);
		const status =
			choice === "recommended"
				? (row[0]?.recommendation ?? "rejected")
				: choice;
		let decided = 0;
		try {
			for (const item of row) {
				await decideOne(item, choice);
				decided += 1;
			}
		} catch (failure) {
			setError(failure);
		} finally {
			setPendingKeys((current) => current.filter((key) => !keys.includes(key)));
		}
		const result =
			decided > 0 ? approvalOutcome(row.slice(0, decided), status) : null;
		if (result) setOutcome(result);
		await refresh();
		return result;
	}

	return {
		items,
		workStartPending,
		expired,
		count,
		/** More runtime requests exist than one read returns. */
		hidden: Math.max(0, runtimeTotal - runtimeShown),
		tediNames,
		canDecide,
		loading:
			(conversationId !== null && runSet.isPending) ||
			runtime.isPending ||
			workStart.isPending,
		readError: runtime.error ?? workStart.error,
		error,
		outcome,
		dismissOutcome: () => setOutcome(null),
		isPending: (key: string) => pendingKeys.includes(key),
		busy: pendingKeys.length > 0,
		decide,
		clearExpired,
	};
}
