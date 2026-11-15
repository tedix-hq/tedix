import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Empty } from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Link } from "@/components/kumo/link";
import { Page } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { workOwnerName } from "@/components/work-factory-pages";
import { useWorkPrincipalNames } from "@/components/work-operations-shared";
import {
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import {
	osQuery,
	projectListQueryOptions,
	userProfileQueryOptions,
	workTriageQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { plainWorkText, workDate } from "@/lib/work-detail";
import { OS_COPY } from "@/shared/os-copy";

type TriageItem = Pick<
	WorkItem,
	| "id"
	| "title"
	| "priority"
	| "projectId"
	| "accountableOwnerType"
	| "accountableOwnerId"
	| "acceptanceContract"
	| "version"
	| "createdAt"
>;
type TriageExit = "accept" | "decline" | "duplicate" | "snooze";
type TriageQueue = { projectId: string | null; count: number };

const NO_PROJECT = "none";
const EXIT_LABELS: Record<TriageExit, string> = {
	accept: "Accept",
	decline: "Decline",
	duplicate: "Duplicate",
	snooze: "Snooze",
};
const PRIORITY_LABELS: Record<WorkItem["priority"], string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
};
export const SNOOZE_DAYS = {
	"1": "Tomorrow",
	"3": "In 3 days",
	"7": "In a week",
	"30": "In a month",
} as const;

/** When a snoozed proposal comes back: the same time of day, `days` later. */
export function snoozeUntil(days: number, now = new Date()): string {
	return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * The queues a person can open: proposals with no project first, then every
 * project that has proposals waiting, busiest first. The open queue stays
 * listed when it is empty.
 */
export function triageQueueOptions(
	queues: readonly TriageQueue[],
	projectNames: ReadonlyMap<string, string>,
	selected: string | undefined,
): { value: string; label: string }[] {
	const waiting = new Map(
		queues.map((queue) => [queue.projectId ?? NO_PROJECT, queue.count]),
	);
	const projects = [
		...new Set([
			...queues.flatMap((queue) => (queue.projectId ? [queue.projectId] : [])),
			...(selected ? [selected] : []),
		]),
	].sort(
		(a, b) =>
			(waiting.get(b) ?? 0) - (waiting.get(a) ?? 0) ||
			(projectNames.get(a) ?? a).localeCompare(projectNames.get(b) ?? b),
	);
	return [
		{
			value: NO_PROJECT,
			label: `No project yet (${waiting.get(NO_PROJECT) ?? 0})`,
		},
		...projects.map((id) => ({
			value: id,
			label: `${projectNames.get(id) ?? "Project"} (${waiting.get(id) ?? 0})`,
		})),
	];
}

export function TriageTable({
	items,
	projectNames,
	principalNames,
	onExit,
}: {
	items: readonly TriageItem[];
	projectNames: ReadonlyMap<string, string>;
	principalNames?: Map<string, string>;
	/** Absent for people who may not decide: the list is then read-only. */
	onExit?: (exit: TriageExit, item: TriageItem) => void;
}) {
	return (
		<Table
			scrollLabel="Triage"
			mobileLayout="stacked"
			className="table-fixed sm:min-w-[60rem]"
		>
			<TableHeader>
				<TableRow>
					<TableHead className="w-[26%]">Title</TableHead>
					<TableHead className="w-[13%]">{OS_COPY.work.project}</TableHead>
					<TableHead className="w-[12%]">{OS_COPY.work.owner}</TableHead>
					<TableHead className="w-[8%]">Priority</TableHead>
					<TableHead className="w-[9%]">Proposed</TableHead>
					{onExit ? <TableHead className="w-[32%]">Decide</TableHead> : null}
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.map((item) => {
					const project = item.projectId
						? projectNames.get(item.projectId)
						: undefined;
					const owner = workOwnerName(
						item.accountableOwnerType,
						item.accountableOwnerId,
						principalNames,
					);
					return (
						<TableRow key={item.id}>
							<TableCell className="py-2! whitespace-normal">
								<Link
									variant="record"
									href={`/work/items/${item.id}`}
									className="font-medium"
								>
									<span className="line-clamp-2">
										{plainWorkText(item.title)}
									</span>
								</Link>
							</TableCell>
							<TableCell
								className="py-2! sm:truncate"
								label={OS_COPY.work.project}
								title={project}
							>
								{item.projectId ? (
									<Link href={`/work/projects/${item.projectId}`}>
										{project ?? "Open project"}
									</Link>
								) : (
									<Text as="span" tone="secondary">
										No project
									</Text>
								)}
							</TableCell>
							<TableCell
								className="py-2! sm:truncate"
								label={OS_COPY.work.owner}
								title={owner}
							>
								{owner}
							</TableCell>
							<TableCell className="py-2!" label="Priority">
								{PRIORITY_LABELS[item.priority]}
							</TableCell>
							<TableCell className="py-2!" label="Proposed">
								<time dateTime={item.createdAt}>
									{workDate(item.createdAt)}
								</time>
							</TableCell>
							{onExit ? (
								<TableCell className="py-2! whitespace-normal" label="Decide">
									<div className="flex min-w-0 flex-wrap gap-1">
										{(Object.keys(EXIT_LABELS) as TriageExit[]).map((exit) => (
											<Button
												key={exit}
												size="sm"
												variant={exit === "accept" ? "default" : "outline"}
												onClick={() => onExit(exit, item)}
											>
												{EXIT_LABELS[exit]}
											</Button>
										))}
									</div>
								</TableCell>
							) : null}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: (id: string) => React.ReactNode;
}) {
	const id = useId();
	return (
		<div className="grid min-w-0 gap-1">
			<Label htmlFor={id}>{label}</Label>
			{children(id)}
		</div>
	);
}

function TriageDialog({
	exit,
	item,
	projectNames,
	viewerId,
	onClose,
}: {
	exit: TriageExit;
	item: TriageItem;
	projectNames: ReadonlyMap<string, string>;
	viewerId: string | undefined;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [projectId, setProjectId] = useState(item.projectId ?? "");
	const [doneWhen, setDoneWhen] = useState(
		item.acceptanceContract?.doneLooksLike ?? "",
	);
	const [reason, setReason] = useState("");
	const [search, setSearch] = useState("");
	const [originalId, setOriginalId] = useState("");
	const [days, setDays] = useState<keyof typeof SNOOZE_DAYS>("7");
	const needle = search.trim();
	const matches = useQuery({
		...osQuery.workItems.list.queryOptions({
			input: { titleContains: needle, limit: 10, offset: 0 },
		}),
		enabled: exit === "duplicate" && needle.length >= 3,
	});
	const originals = (matches.data?.data ?? []).filter(
		(match) => match.id !== item.id && match.disposition !== "cancelled",
	);
	const ownerMissing = !item.accountableOwnerId;
	const ready =
		exit === "accept"
			? Boolean(projectId && doneWhen.trim() && (!ownerMissing || viewerId))
			: exit === "decline"
				? Boolean(reason.trim())
				: exit === "duplicate"
					? Boolean(originalId)
					: true;
	const decide = useMutation({
		mutationFn: async () => {
			if (exit === "decline")
				return osApi.workItems.decline({ id: item.id, reason: reason.trim() });
			if (exit === "duplicate")
				return osApi.workItems.markDuplicate({
					id: item.id,
					duplicateOfWorkItemId: originalId,
				});
			if (exit === "snooze")
				return osApi.workItems.snooze({
					id: item.id,
					until: snoozeUntil(Number(days)),
				});
			// Acceptance needs a project and an owner on the Work Item first.
			if (projectId !== item.projectId || ownerMissing)
				await osApi.workItems.updateSpecification({
					id: item.id,
					expectedWorkItemVersion: item.version,
					...(projectId !== item.projectId ? { projectId } : {}),
					...(ownerMissing && viewerId
						? {
								accountableOwnerType: "user" as const,
								accountableOwnerId: viewerId,
							}
						: {}),
				});
			return osApi.workItems.accept({
				id: item.id,
				acceptanceContract: { version: 1, doneLooksLike: doneWhen.trim() },
			});
		},
		// A half-done accept (filed, not yet accepted) must show its new state.
		onSettled: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
		onSuccess: onClose,
	});
	const title = plainWorkText(item.title);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !decide.isPending) onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid min-w-0 gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (ready) decide.mutate();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{EXIT_LABELS[exit]}: {title}
						</DialogTitle>
						<DialogDescription>
							{exit === "accept"
								? "Accepted work needs a project, a statement of what done looks like and an accountable owner."
								: exit === "decline"
									? "Declined work is cancelled. Say why, so the person who proposed it can see the reason."
									: exit === "duplicate"
										? "Tedix links this proposal to the Work Item that already covers it and cancels the proposal."
										: "A snoozed proposal leaves the triage lists and comes back on its own."}
						</DialogDescription>
					</DialogHeader>
					{exit === "accept" ? (
						<>
							<Field label={OS_COPY.work.project}>
								{(id) => (
									<Select
										value={projectId}
										items={Object.fromEntries(projectNames)}
										onValueChange={(next) => setProjectId(next ?? "")}
									>
										<SelectTrigger id={id} className="w-full">
											<SelectValue placeholder="Choose a project" />
										</SelectTrigger>
										<SelectContent>
											{[...projectNames].map(([value, name]) => (
												<SelectItem key={value} value={value}>
													{name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
							<Field label="Done when">
								{(id) => (
									<Textarea
										id={id}
										value={doneWhen}
										maxLength={2000}
										placeholder="What will be true when this is finished?"
										onChange={(event) => setDoneWhen(event.target.value)}
									/>
								)}
							</Field>
							{ownerMissing ? (
								<Text tone="secondary">
									Nobody owns this yet. Accepting makes you the accountable
									owner; you can hand it to someone else afterwards.
								</Text>
							) : null}
						</>
					) : null}
					{exit === "decline" ? (
						<Field label="Reason">
							{(id) => (
								<Textarea
									id={id}
									value={reason}
									maxLength={2000}
									placeholder="Why will this not be done?"
									onChange={(event) => setReason(event.target.value)}
								/>
							)}
						</Field>
					) : null}
					{exit === "duplicate" ? (
						<>
							<Field label="Find the Work Item that already covers this">
								{(id) => (
									<Input
										id={id}
										value={search}
										maxLength={200}
										placeholder="Type part of its title"
										onChange={(event) => {
											setSearch(event.target.value);
											setOriginalId("");
										}}
									/>
								)}
							</Field>
							{needle.length >= 3 && matches.isSuccess && !originals.length ? (
								<Text tone="secondary">No other Work Item matches.</Text>
							) : null}
							{matches.isError ? (
								<Text tone="error">
									{errorMessage(matches.error, "The search failed.")}
								</Text>
							) : null}
							{originals.length ? (
								<ul className="grid min-w-0 gap-1" aria-label="Matching work">
									{originals.map((match) => (
										<li key={match.id} className="min-w-0">
											<Button
												type="button"
												variant={
													match.id === originalId ? "secondary" : "ghost"
												}
												aria-pressed={match.id === originalId}
												className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
												onClick={() => setOriginalId(match.id)}
											>
												<span className="line-clamp-2 wrap-anywhere">
													{plainWorkText(match.title)} ·{" "}
													{OS_COPY.work.dispositions[match.disposition]}
												</span>
											</Button>
										</li>
									))}
								</ul>
							) : null}
						</>
					) : null}
					{exit === "snooze" ? (
						<Field label="Bring it back">
							{(id) => (
								<Select
									value={days}
									items={SNOOZE_DAYS}
									onValueChange={(next) => {
										if (next && Object.hasOwn(SNOOZE_DAYS, next))
											setDays(next as keyof typeof SNOOZE_DAYS);
									}}
								>
									<SelectTrigger id={id} className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{Object.entries(SNOOZE_DAYS).map(([value, label]) => (
											<SelectItem key={value} value={value}>
												{label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					) : null}
					{decide.isError ? (
						<div role="alert">
							<Text tone="error">
								{errorMessage(decide.error, "That did not work. Try again.")}
							</Text>
						</div>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={decide.isPending}
							onClick={onClose}
						>
							Keep in triage
						</Button>
						<Button
							type="submit"
							disabled={!ready || decide.isPending}
							loading={decide.isPending}
						>
							{EXIT_LABELS[exit]}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Work → Triage: proposed work waiting for a decision, one queue at a time. */
export function WorkTriageView({
	project,
	onProjectChange,
}: {
	project: string | undefined;
	onProjectChange: (project: string | undefined) => void;
}) {
	const queueId = useId();
	const queue = useQuery(workTriageQueryOptions(project));
	const projects = useQuery(projectListQueryOptions(100));
	const viewer = useQuery(userProfileQueryOptions());
	const role = useOsOperationalContext().data?.authority?.role;
	const [deciding, setDeciding] = useState<{
		exit: TriageExit;
		item: TriageItem;
	} | null>(null);
	const projectNames = useMemo(
		() =>
			new Map(
				(projects.data?.data ?? []).map((entry) => [entry.id, entry.name]),
			),
		[projects.data],
	);
	const items = queue.data?.data ?? [];
	const principalNames = useWorkPrincipalNames(items[0]?.orgId);
	const options = triageQueueOptions(
		queue.data?.queues ?? [],
		projectNames,
		project,
	);
	const total = queue.data?.pagination.total ?? 0;
	const snoozed = queue.data?.snoozed ?? 0;
	// The API lets an organization owner or admin decide for any Work Item.
	const mayDecide = role === "owner" || role === "admin";
	return (
		<Page width="full">
			<WorkPageHeader
				title="Triage"
				description="Proposed work waiting for a decision. Accept it, decline it, mark it as a duplicate or snooze it."
			/>
			<div className="grid min-w-0 gap-1 sm:max-w-sm">
				<Label htmlFor={queueId}>Queue</Label>
				<Select
					value={project ?? NO_PROJECT}
					items={Object.fromEntries(
						options.map((option) => [option.value, option.label]),
					)}
					onValueChange={(next) =>
						onProjectChange(!next || next === NO_PROJECT ? undefined : next)
					}
				>
					<SelectTrigger id={queueId} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{options.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{queue.isPending ? (
				<WorkListSkeleton rows={6} label="Loading triage" />
			) : queue.isError && !items.length ? (
				<WorkReadFailure
					title="Triage unavailable"
					error={queue.error}
					onRetry={() => queue.refetch()}
					retrying={queue.isRefetching}
				/>
			) : items.length ? (
				<TriageTable
					items={items}
					projectNames={projectNames}
					principalNames={principalNames}
					onExit={
						mayDecide ? (exit, item) => setDeciding({ exit, item }) : undefined
					}
				/>
			) : (
				<Empty
					title={
						project
							? "Nothing waits in this project"
							: "No proposals without a project"
					}
				/>
			)}
			<Text tone="secondary" aria-live="polite">
				{total > items.length
					? `Showing the first ${items.length} of ${total} waiting. `
					: `${total} waiting. `}
				{snoozed ? `${snoozed} snoozed.` : null}
				{mayDecide
					? null
					: " An organization owner or admin decides what leaves triage."}
			</Text>
			{deciding ? (
				<TriageDialog
					key={`${deciding.exit}:${deciding.item.id}`}
					exit={deciding.exit}
					item={deciding.item}
					projectNames={projectNames}
					viewerId={viewer.data?.id}
					onClose={() => setDeciding(null)}
				/>
			) : null}
		</Page>
	);
}
