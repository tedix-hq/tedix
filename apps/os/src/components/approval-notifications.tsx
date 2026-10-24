import {
	CaretRight,
	Check,
	CheckCircle,
	DotsThree,
	Pulse,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";
import { ActivityAutoApproval } from "@/components/activity-auto-approval";
import { ActivityHistory } from "@/components/activity-history";
import {
	type ApprovalCardData,
	approvalsFromRunSet,
	approvalsForAuthority,
	hasOsApprovalAuthority,
} from "@/components/chat-cards";
import { EntityAvatar } from "@/components/entity-avatar";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import {
	PopoverContent,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { OsTopbarMenuContext } from "@/components/os-topbar-actions-context";
import { osApi, osChatMutationApi } from "@/lib/api";
import { appLabel, plainApprovalTitle } from "@/lib/approval-titles";
import {
	homeRunSetQueryOptions,
	operationalContextQueryOptions,
	osQueryKeys,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { useTediNames } from "@/lib/use-tedi-names";
import { workRefreshOptions } from "@/lib/work-refresh";

export function approvalAttentionCount(input: {
	home: number;
	runtime: number;
}): number {
	return input.home + input.runtime;
}

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

/** One row in the popover, whichever plane the decision belongs to. */
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
	/** Plain-language consequence copy shown when the row is expanded. */
	what: string;
	ifApproved: string;
	ifRejected: string;
	recommendation: "approved" | "rejected";
	recommendationReason: string;
	technical: string | null;
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

function homeItem(approval: ApprovalCardData): ApprovalListItem {
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
		where: null,
		requestedAt: approval.requestedAt ?? null,
		expiresAt: approval.expiresAt ?? null,
		chip: delegationHoldChip(approval.detail),
		what: decision.what,
		ifApproved: decision.ifApproved,
		ifRejected: decision.ifRejected,
		recommendation: decision.recommendation,
		recommendationReason: decision.reason,
		technical: approval.detail ?? null,
		target: { plane: "home", runId: approval.runId },
	};
}

function runtimeItem(
	approval: RuntimeApproval,
	tediNames: Record<string, string>,
): ApprovalListItem {
	const decision = approvalDecision(approval);
	const name = tediNames[approval.tediId] ?? null;
	return {
		key: approval.id,
		title: plainApprovalTitle(
			approval.review.summary || approval.description,
			approval.payload,
		),
		kind: "Action",
		tedi: name ? { id: approval.tediId, name } : null,
		where:
			typeof approval.payload.appSlug === "string"
				? appLabel(approval.payload.appSlug)
				: null,
		requestedAt: approval.createdAt,
		expiresAt: approval.expiresAt,
		chip:
			approval.payload.riskTier === "high"
				? { label: "High risk", tone: "error" }
				: (RUNTIME_INTENT_CHIPS[approval.review.intent] ?? {
						label: "Needs review",
						tone: "secondary",
					}),
		what: decision.what,
		ifApproved: decision.ifApproved,
		ifRejected: decision.ifRejected,
		recommendation: decision.recommendation,
		recommendationReason: decision.reason,
		technical: approval.description,
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
		].join("\u0000");
		rows.set(key, [...(rows.get(key) ?? []), item]);
	}
	return [...rows.values()];
}

export type ActivityTab = "review" | "auto" | "history";

export const approvalGroupHeadingClassName =
	"m-0 flex min-w-0 items-center gap-2 break-words px-4 pb-1 pt-3 text-kumo-subtle type-tedix-caption font-semibold";

export function ApprovalNotifications({
	conversationId = null,
	topbar = false,
}: {
	conversationId?: string | null;
	topbar?: boolean;
}) {
	const queryClient = useQueryClient();
	const topbarMenu = useContext(OsTopbarMenuContext);
	const menu = topbar ? topbarMenu : null;
	const [open, setOpen] = useState(false);
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
	const pendingHome = useQuery({
		...pendingHomeDelegationsQueryOptions(),
		...workRefreshOptions,
	});
	const homeApprovals = runSet.data
		? approvalsForAuthority(
				approvalsFromRunSet(runSet.data.runSet),
				authority,
			).filter(isActionableHomeApproval)
		: [];
	const globalHomeApprovals = pendingHome.data
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
	const homeApprovalIds = new Set(homeApprovals.map((a) => a.approvalId));
	const runtimeApprovals = (runtime.data?.data ?? []).filter(
		(approval) =>
			hasOsApprovalAuthority(authority) &&
			!homeApprovalIds.has(approval.id) &&
			isActionableRuntimeApproval(approval),
	);
	const items = [
		...[...homeApprovals, ...globalHomeApprovals].map(homeItem),
		...runtimeApprovals.map((approval) => runtimeItem(approval, tediNames)),
	];
	const count = approvalAttentionCount({
		home: homeApprovals.length + globalHomeApprovals.length,
		runtime: runtimeApprovals.length,
	});

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
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: pendingHomeDelegationsQueryOptions().queryKey,
			});
			if (conversationId !== null) {
				await queryClient.invalidateQueries({
					queryKey: homeRunSetQueryOptions(conversationId).queryKey,
				});
			}
		},
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
						? "Approved from the Tedix OS attention menu after reviewing the exact request."
						: "Rejected from the Tedix OS attention menu after reviewing the exact request.",
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.approvals(),
			});
		},
	});
	const error = respondHome.error ?? resolveRuntime.error;
	const busy = respondHome.isPending || resolveRuntime.isPending;
	const [tab, setTab] = useState<ActivityTab>("review");

	function decideOne(
		item: ApprovalListItem,
		choice: "approved" | "rejected" | "recommended",
	) {
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

	/** One decision for every identical request in the row, in order. */
	async function decide(
		row: readonly ApprovalListItem[],
		choice: "approved" | "rejected" | "recommended",
	) {
		for (const item of row) {
			try {
				await decideOne(item, choice);
			} catch {
				// The mutation's error is rendered below the list; stop here so
				// the remaining requests stay waiting rather than half-decided.
				return;
			}
		}
	}

	const loading =
		(conversationId !== null && runSet.isPending) ||
		runtime.isPending ||
		pendingHome.isPending;

	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			{menu ? (
				menu.target &&
				createPortal(
					<DropdownMenuItem onClick={() => setOpen(true)}>
						<Pulse aria-hidden size={18} />
						Activity{count > 0 ? <Badge>{count} waiting</Badge> : null}
					</DropdownMenuItem>,
					menu.target,
				)
			) : (
				<PopoverTrigger
					render={
						<Button
							aria-label={
								count === 0
									? "Action approvals: none waiting"
									: `Action approvals: ${count} waiting`
							}
							className="relative"
							size="icon-sm"
							title="Activity"
							variant={count > 0 ? "secondary" : "ghost"}
						>
							<Pulse size={16} weight={count > 0 ? "bold" : "regular"} />
							{count > 0 ? (
								<Badge className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 tabular-nums">
									{count > 99 ? "99+" : count}
								</Badge>
							) : null}
						</Button>
					}
				/>
			)}
			<PopoverContent
				anchor={menu?.anchor}
				finalFocus={menu?.anchor}
				align="end"
				className="w-[min(28rem,calc(100vw-2rem))] max-h-[min(40rem,var(--available-height))] gap-0 p-0"
				data-approvals-popover=""
				side="bottom"
			>
				<Tabs
					className="gap-0"
					onValueChange={(value) => setTab(value as ActivityTab)}
					value={tab}
				>
					<header className="sticky top-0 z-10 grid gap-2 border-b border-kumo-hairline bg-kumo-base px-4 pt-3">
						<div className="grid min-w-0 gap-0.5">
							<PopoverTitle className="m-0 font-semibold text-kumo-default type-tedix-body">
								Activity
							</PopoverTitle>
							<PopoverDescription className="m-0 text-kumo-subtle type-tedix-label">
								{count === 0
									? "Nothing is waiting for you."
									: `${count} waiting for your decision`}
							</PopoverDescription>
						</div>
						<TabsList
							aria-label="Activity sections"
							className="-mx-1 !h-9 border-b-0"
							variant="line"
						>
							<TabsTrigger className="px-2!" value="review">
								Needs review
								{count > 0 ? (
									<Badge className="ml-1.5 tabular-nums" variant="secondary">
										{count > 99 ? "99+" : count}
									</Badge>
								) : null}
							</TabsTrigger>
							<TabsTrigger className="px-2!" value="auto">
								Auto-approval
							</TabsTrigger>
							<TabsTrigger className="px-2!" value="history">
								History
							</TabsTrigger>
						</TabsList>
					</header>

					<TabsContent value={tab}>
						{tab === "auto" ? (
							<ActivityAutoApproval
								canChange={hasOsApprovalAuthority(authority)}
							/>
						) : tab === "history" ? (
							<ActivityHistory tediNames={tediNames} />
						) : loading ? (
							<Text className="m-0 px-4 py-6" role="label" tone="secondary">
								Checking for pending decisions…
							</Text>
						) : items.length === 0 ? (
							<Empty
								appearance="inline"
								className="px-4! py-6!"
								icon={
									<CheckCircle
										aria-hidden
										className="text-kumo-subtle"
										size={24}
									/>
								}
								title="No approvals waiting"
								description="When an agent needs your OK to change, send or pay for something, it waits here."
							/>
						) : (
							<div className="grid">
								{groupApprovalItems(items).map((group) => (
									<section
										aria-label={`${group.label}: ${group.items.length} waiting`}
										className="border-b border-kumo-hairline last:border-b-0"
										key={group.label}
									>
										<h3 className={approvalGroupHeadingClassName}>
											{sanitizeUntrustedText(group.label)}
											<span className="tabular-nums font-normal">
												{group.items.length}
											</span>
										</h3>
										<ul className="m-0 grid list-none p-0 pb-1">
											{collapseIdenticalItems(group.items).map((row) => (
												<ApprovalRow
													busy={busy}
													items={row}
													key={row[0]?.key}
													onDecide={(choice) => void decide(row, choice)}
												/>
											))}
										</ul>
									</section>
								))}
							</div>
						)}
					</TabsContent>
				</Tabs>

				{tab === "review" && error ? (
					<Text className="m-0 px-4 py-2" role="label" tone="error">
						The decision could not be recorded:{" "}
						{error instanceof Error ? error.message : "Unknown error"}
					</Text>
				) : null}
				<footer className="sticky bottom-0 border-t border-kumo-hairline bg-kumo-base px-2 py-1.5">
					<Link
						className="flex min-h-9 items-center justify-between rounded-md px-2 text-kumo-default no-underline type-tedix-control hover:bg-kumo-tint max-sm:min-h-11"
						href="/work/approvals"
					>
						Open the approvals page
						<CaretRight aria-hidden size={14} />
					</Link>
				</footer>
			</PopoverContent>
		</PopoverRoot>
	);
}

function ApprovalRow({
	items,
	busy,
	onDecide,
}: {
	/** One request, or several identical ones decided together. */
	items: readonly ApprovalListItem[];
	busy: boolean;
	onDecide: (choice: "approved" | "rejected" | "recommended") => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const item = items[0]!;
	const repeats = items.length;
	// The soonest window is the one that matters: after it, a request expires.
	const expiresAt =
		items
			.map((entry) => entry.expiresAt)
			.filter((value): value is string => value !== null)
			.sort()[0] ?? null;
	const title = sanitizeUntrustedText(item.title);
	const recommended = item.recommendation === "approved" ? "Approve" : "Reject";
	return (
		<li className="grid min-w-0 gap-2 px-4 py-2.5">
			<Collapsible open={expanded} onOpenChange={setExpanded}>
				<div className="flex min-w-0 items-start gap-3">
					{item.tedi ? (
						<EntityAvatar
							className="mt-0.5 size-7"
							id={item.tedi.id}
							kind="tedi"
							name={item.tedi.name}
						/>
					) : (
						<span
							aria-hidden
							className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle"
						>
							<Pulse size={14} />
						</span>
					)}
					<div className="grid min-w-0 flex-1 gap-1">
						<CollapsibleTrigger
							aria-label={`${title}. ${expanded ? "Hide" : "Show"} details`}
							className="group/disclosure -mx-2 min-h-0 items-start px-2 py-0.5 text-kumo-default"
						>
							<span className="line-clamp-2 min-w-0 flex-1 font-medium type-tedix-control">
								{title}
							</span>
							<CaretRight
								aria-hidden
								className="mt-1 shrink-0 text-kumo-subtle transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
								size={12}
							/>
						</CollapsibleTrigger>
						<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle type-tedix-label">
							<Badge variant={item.chip.tone}>{item.chip.label}</Badge>
							{repeats > 1 ? (
								<Badge variant="outline">{repeats} identical</Badge>
							) : null}
							<span>
								{item.kind}
								{item.where ? ` in ${sanitizeUntrustedText(item.where)}` : ""}
							</span>
							{item.requestedAt ? (
								<time
									dateTime={item.requestedAt}
									title={`Asked ${absoluteTime(item.requestedAt)}`}
								>
									{relativeTime(item.requestedAt)}
								</time>
							) : null}
							{expiresAt ? (
								<time
									dateTime={expiresAt}
									title={`Expires ${absoluteTime(expiresAt)}`}
								>
									expires {relativeTime(expiresAt)}
								</time>
							) : null}
						</div>
					</div>
				</div>
				<CollapsibleContent>
					<dl className="m-0 mt-2 grid gap-1.5 rounded-md border border-kumo-hairline p-3 type-tedix-label">
						{[
							["What", item.what],
							["If you approve", item.ifApproved],
							["If you reject", item.ifRejected],
						].map(([label, text]) => (
							<div className="grid gap-0.5" key={label}>
								<dt className="text-kumo-subtle">{label}</dt>
								<dd className="m-0 text-kumo-default">{text}</dd>
							</div>
						))}
						{item.technical ? (
							<div className="grid gap-0.5">
								<dt className="text-kumo-subtle">Why it stopped</dt>
								<dd className="m-0 break-words font-mono text-kumo-default">
									{sanitizeUntrustedText(item.technical)}
								</dd>
							</div>
						) : null}
						<div className="pt-1">
							<Badge title={item.recommendationReason} variant="outline">
								Suggested: {recommended}
							</Badge>
						</div>
					</dl>
				</CollapsibleContent>
			</Collapsible>
			<div className="flex items-center gap-2 pl-10">
				<Button
					disabled={busy}
					icon={<Check size={14} />}
					onClick={() => onDecide("approved")}
					size="sm"
				>
					{repeats > 1 ? `Approve all ${repeats}` : "Approve"}
				</Button>
				<Button
					disabled={busy}
					icon={<X size={14} />}
					onClick={() => onDecide("rejected")}
					size="sm"
					variant="secondary"
				>
					{repeats > 1 ? `Reject all ${repeats}` : "Reject"}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={`More actions for ${title}`}
								className="ml-auto"
								disabled={busy}
								size="icon-sm"
								variant="ghost"
							>
								<DotsThree size={16} weight="bold" />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => onDecide("recommended")}>
							Decide for me ({recommended.toLowerCase()})
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setExpanded((value) => !value)}>
							{expanded ? "Hide details" : "Show details"}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</li>
	);
}
