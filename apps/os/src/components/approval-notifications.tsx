import {
	CaretRight,
	Check,
	CheckCircle,
	DotsThree,
	Pulse,
	X,
} from "@phosphor-icons/react";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";
import { ActivityAutoApproval } from "@/components/activity-auto-approval";
import { ActivityHistory } from "@/components/activity-history";
import {
	type ApprovalChoice,
	type ApprovalListItem,
	collapseIdenticalItems,
	groupApprovalItems,
	useApprovalInbox,
} from "@/components/approval-inbox";
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
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

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
	const topbarMenu = useContext(OsTopbarMenuContext);
	const menu = topbar ? topbarMenu : null;
	const [open, setOpen] = useState(false);
	const inbox = useApprovalInbox({ conversationId });
	const { items, count, error, loading } = inbox;
	const [tab, setTab] = useState<ActivityTab>("review");

	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			{menu ? (
				menu.target &&
				createPortal(
					<DropdownMenuItem onClick={() => setOpen(true)}>
						<Pulse aria-hidden size={18} />
						Approvals{count > 0 ? <Badge>{count} waiting</Badge> : null}
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
							title="Approvals"
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
								Approvals
							</PopoverTitle>
							<PopoverDescription className="m-0 text-kumo-subtle type-tedix-label">
								{count === 0
									? "Nothing is waiting for you."
									: `${count} waiting for your decision`}
							</PopoverDescription>
						</div>
						<TabsList
							aria-label="Approvals sections"
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
							<ActivityAutoApproval canChange={inbox.canDecide} />
						) : tab === "history" ? (
							<ActivityHistory tediNames={inbox.tediNames} />
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
													busy={row.some((entry) => inbox.isPending(entry.key))}
													items={row}
													key={row[0]?.key}
													onDecide={(choice) => void inbox.decide(row, choice)}
												/>
											))}
										</ul>
									</section>
								))}
							</div>
						)}
					</TabsContent>
				</Tabs>

				{tab === "review" && inbox.outcome ? (
					<div className="px-4 py-2" role="status">
						<Text as="p" className="m-0" role="label">
							{sanitizeUntrustedText(inbox.outcome.message)}
						</Text>
					</div>
				) : null}
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
	onDecide: (choice: ApprovalChoice) => void;
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
							["What", [item.what, ...item.details].join(" · ")],
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
			<div className="flex min-w-0 flex-wrap items-center gap-2 sm:pl-10">
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
							Follow the suggestion ({recommended.toLowerCase()})
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
