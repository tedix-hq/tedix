import {
	Archive,
	ArrowCounterClockwise,
	ChatCircleText,
	Code,
	Eye,
	FilePlus,
	Files,
	Globe,
	ListChecks,
	PencilSimple,
	Plugs,
	SlidersHorizontal,
	TextAa,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WorkspaceActivityItem } from "@tedix/api-contract/schemas/workspace-feed";
import { type ComponentType, useEffect } from "react";
import { WorkspaceAppTriggers } from "./workspace-app-connections";
import { LoadingArea } from "@/components/loading-area";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	canvasOutputsQueryOptions,
	osQuery,
	workspaceCollaboratorsQueryOptions,
	workspacePresenceQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, dayHeading, dayKey, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { useTediNames } from "@/lib/use-tedi-names";

/** How many lines the list tries to show before it stops reading further back by itself. */
const ACTIVITY_FIRST_VIEW = 8;
/** The most pages read without the person asking for more. */
const ACTIVITY_AUTO_PAGES = 8;

/** Only file changes and agent actions are shown; chat steps stay in their conversation. */
const WORKSPACE_ACTIVITY_KINDS = ["output", "run"] as const;

type Outcome = NonNullable<WorkspaceActivityItem["action"]>["outcome"];

/** What was done, in the three forms a sentence needs. */
type Deed = {
	icon: ComponentType<{ size?: number }>;
	/** "archived" in "Luz archived Plan". */
	past: string;
	/** "archive" in "Luz asked to archive Plan". */
	base: string;
	/** The sentence names a file after the verb. */
	file: boolean;
	/** Entries that record the same change share a group. */
	group?: "created" | "changed" | "archived" | "details";
};

const DEEDS = {
	registeredSchedule: {
		icon: SlidersHorizontal,
		past: "registered a scheduled run",
		base: "register a scheduled run",
		file: false,
	},
	created: {
		icon: FilePlus,
		past: "created",
		base: "create",
		file: true,
		group: "created",
	},
	changed: {
		icon: PencilSimple,
		past: "changed",
		base: "change",
		file: true,
		group: "changed",
	},
	renamed: {
		icon: TextAa,
		past: "renamed",
		base: "rename",
		file: true,
		group: "details",
	},
	archived: {
		icon: Archive,
		past: "archived",
		base: "archive",
		file: true,
		group: "archived",
	},
	restored: {
		icon: ArrowCounterClockwise,
		past: "restored",
		base: "restore",
		file: true,
		group: "details",
	},
	details: {
		icon: SlidersHorizontal,
		past: "changed the details of",
		base: "change the details of",
		file: true,
		group: "details",
	},
	read: { icon: Eye, past: "read", base: "read", file: true },
	listedFiles: {
		icon: Files,
		past: "looked through the files here",
		base: "look through the files here",
		file: false,
	},
	listedTasks: {
		icon: ListChecks,
		past: "looked at the tasks here",
		base: "look at the tasks here",
		file: false,
	},
	createdTask: {
		icon: ListChecks,
		past: "created a task",
		base: "create a task",
		file: false,
	},
	readWeb: {
		icon: Globe,
		past: "read a web page",
		base: "read a web page",
		file: false,
	},
	openedSite: {
		icon: Globe,
		past: "opened a new website",
		base: "open a new website",
		file: false,
	},
	showedView: {
		icon: ChatCircleText,
		past: "showed a view in the chat",
		base: "show a view in the chat",
		file: false,
	},
	readApp: {
		icon: Code,
		past: "read an app's code",
		base: "read an app's code",
		file: false,
	},
	createdApp: {
		icon: Code,
		past: "created an app",
		base: "create an app",
		file: false,
	},
	changedApp: {
		icon: Code,
		past: "changed an app",
		base: "change an app",
		file: false,
	},
	proposedAppChange: {
		icon: Code,
		past: "proposed a change to an app",
		base: "propose a change to an app",
		file: false,
	},
	listedSources: {
		icon: Plugs,
		past: "looked at the connected sources",
		base: "look at the connected sources",
		file: false,
	},
} satisfies Record<string, Deed>;

type DeedName = keyof typeof DEEDS;

/**
 * The deed a recorded agent action stands for; null for chat steps, for the
 * check an app passes before it is created, and for anything with no plain
 * name: a line that says only that something happened tells the reader nothing.
 */
function actionDeed(resource: string, operation: string): DeedName | null {
	if (resource === "app_schedule" && operation === "schedule.registered")
		return "registeredSchedule";
	if (resource === "conversation") return null;
	if (resource === "output" || resource === "outputs") {
		if (operation === "create") return "created";
		if (operation === "archive") return "archived";
		if (operation === "restore") return "restored";
		if (operation === "update_metadata") return "details";
		if (operation === "read" || operation === "get") return "read";
		if (operation === "list") return "listedFiles";
		return "changed";
	}
	if (resource === "work")
		return operation === "create" ? "createdTask" : "listedTasks";
	if (resource === "web") return "readWeb";
	if (resource === "web_domain") return "openedSite";
	if (resource === "view") return "showedView";
	if (resource === "app") {
		if (operation === "create") return "createdApp";
		if (/^(read|get|list|grep)/.test(operation)) return "readApp";
		return "changedApp";
	}
	if (resource === "app_draft") return "proposedAppChange";
	if (resource === "resource") return "listedSources";
	return null;
}

/** One line of the list: who did what to which file, and when. */
export type WorkspaceActivityEntry = {
	id: string;
	at: string;
	deed: DeedName;
	/** The words before the file name, or the whole sentence without one. */
	lead: string;
	/** The file the sentence names; `href` is set only for a file that can be opened. */
	file: { title: string; href: string | null } | null;
	/** The words after the file name. */
	tail: string;
	automaticRun?: { gadgetId: string; triggerId: string };
};

export type WorkspaceActivityNames = {
	/** The signed-in person's id; their own entries read "You". */
	viewerId?: string | null;
	people?: Record<string, string>;
	tedis?: Record<string, string>;
	/** File titles by file id, for entries that carry none. */
	files?: Record<string, string>;
};

/**
 * An action the workspace's agent took is recorded under the person whose
 * message it was answering; the sentence still has to say the agent did it.
 */
function byWorkspaceAgent(item: WorkspaceActivityItem): boolean {
	return item.kind === "run" && item.action?.surface === "workspace_object";
}

function actorName(
	item: WorkspaceActivityItem,
	names: WorkspaceActivityNames,
): string {
	const actor = item.actor;
	if (byWorkspaceAgent(item))
		return actor.kind === "tedi"
			? (names.tedis?.[actor.id] ?? "The agent")
			: "The agent";
	if (actor.kind === "user") {
		if (names.viewerId && actor.id === names.viewerId) return "You";
		return names.people?.[actor.id] ?? "Someone";
	}
	if (actor.kind === "tedi") return names.tedis?.[actor.id] ?? "An agent";
	if (actor.kind === "external_agent") return "The agent";
	// A background save or a request that carried no person.
	return "Someone";
}

function sentence(
	who: string,
	deed: Deed,
	outcome: Outcome,
): { lead: string; tail: string } {
	const you = who === "You";
	if (outcome === "denied")
		return {
			lead: `${who} ${you ? "were" : "was"} not allowed to ${deed.base}`,
			tail: "",
		};
	if (outcome === "needs_approval")
		return { lead: `${who} asked to ${deed.base}`, tail: "" };
	if (outcome === "not_applied")
		return {
			lead: `${who} tried to ${deed.base}`,
			tail: ", but it did not go through",
		};
	if (outcome === "unknown")
		return {
			lead: `${who} tried to ${deed.base}`,
			tail: "; it is not known whether it went through",
		};
	return { lead: `${who} ${deed.past}`, tail: "" };
}

/**
 * Recorded changes as sentences, newest first. Entries of another workspace,
 * file changes the API could not verify, and chat steps are left out. A file
 * change and the agent action that made it are told once.
 */
export function workspaceActivityEntries(
	items: readonly WorkspaceActivityItem[],
	workspaceId: string,
	names: WorkspaceActivityNames = {},
): WorkspaceActivityEntry[] {
	const visible = items.filter(
		(item) =>
			item.workspaceId === workspaceId &&
			(item.kind === "output"
				? Boolean(item.artifact)
				: item.kind === "run" && Boolean(item.action)),
	);
	const titles: Record<string, string> = { ...names.files };
	for (const item of visible)
		if (item.kind === "output" && item.artifact && item.title)
			titles[item.artifact.outputId] ??= item.title;

	// Oldest first, so a rename or a restore can be told from what came before.
	const known = new Map<string, { title: string | null; archived: boolean }>();
	const drafts: (WorkspaceActivityEntry & {
		item: WorkspaceActivityItem;
		outcome: Outcome;
	})[] = [];
	for (const item of [...visible].reverse()) {
		const outputId = item.artifact?.outputId ?? null;
		const before = outputId ? known.get(outputId) : undefined;
		let deed: DeedName | null;
		if (item.action) {
			deed = actionDeed(item.action.resource, item.action.operation);
		} else if (item.summary?.startsWith("Archived ")) {
			deed = "archived";
		} else if (item.summary?.startsWith("Updated ")) {
			deed = before?.archived
				? "restored"
				: before?.title && item.title && before.title !== item.title
					? "renamed"
					: "details";
		} else {
			deed = item.revision <= 1 ? "created" : "changed";
		}
		if (!deed) continue;
		const outcome = item.action?.outcome ?? "applied";
		if (outputId && outcome === "applied")
			known.set(outputId, {
				title: item.title ?? before?.title ?? null,
				archived:
					deed === "archived"
						? true
						: deed === "restored"
							? false
							: (before?.archived ?? false),
			});
		const spec: Deed = DEEDS[deed];
		const title = outputId ? (item.title ?? titles[outputId] ?? null) : null;
		drafts.push({
			id: item.id,
			...(outcome === "applied" && item.action?.automaticRun
				? { automaticRun: item.action.automaticRun }
				: {}),
			at: item.occurredAt,
			deed,
			...sentence(actorName(item, names), spec, outcome),
			file: spec.file
				? {
						title: title ?? "a file",
						href: outputId ? `/outputs/${encodeURIComponent(outputId)}` : null,
					}
				: null,
			item,
			outcome,
		});
	}

	// A save is recorded as a file change and, when an agent made it, as that
	// agent's action too: keep the one that names who did it.
	const merged: typeof drafts = [];
	for (const draft of drafts) {
		const group = (DEEDS[draft.deed] as Deed).group;
		const revisionId = draft.item.artifact?.revisionId;
		const twin =
			group && revisionId && draft.outcome === "applied"
				? merged.findIndex(
						(other) =>
							other.outcome === "applied" &&
							other.item.kind !== draft.item.kind &&
							other.item.artifact?.revisionId === revisionId &&
							(DEEDS[other.deed] as Deed).group === group &&
							Math.abs(Date.parse(other.at) - Date.parse(draft.at)) < 60_000,
					)
				: -1;
		const other = merged[twin];
		if (!other) {
			merged.push(draft);
			continue;
		}
		const named = (entry: (typeof drafts)[number]) =>
			entry.item.actor.kind !== "service";
		// The agent's own record says who really made the change. The store's
		// unsigned note of a rename or archive does not: a person's line wins.
		const agentRecord = (entry: (typeof drafts)[number]) =>
			byWorkspaceAgent(entry.item) && named(entry);
		const keep = agentRecord(draft)
			? draft
			: agentRecord(other) || named(other) || !named(draft)
				? other
				: draft;
		// "restored" and "renamed" say more than "changed the details of".
		const deed =
			[other, draft].find((entry) => entry.deed !== "details")?.deed ??
			keep.deed;
		merged[twin] = {
			...keep,
			deed,
			...sentence(actorName(keep.item, names), DEEDS[deed], keep.outcome),
			file: [keep, other, draft].find(
				(entry) => entry.file && entry.file.title !== "a file",
			)?.file ??
				keep.file ?? { title: "a file", href: null },
		};
	}
	return merged
		.reverse()
		.map(({ item: _item, outcome: _outcome, ...entry }) => entry);
}

/** Entries under the day they happened on, keeping their order. */
export function groupActivityByDay(
	entries: readonly WorkspaceActivityEntry[],
	now: Date = new Date(),
): { day: string; label: string; entries: WorkspaceActivityEntry[] }[] {
	const days: {
		day: string;
		label: string;
		entries: WorkspaceActivityEntry[];
	}[] = [];
	for (const entry of entries) {
		const day = dayKey(entry.at);
		const last = days.at(-1);
		if (last?.day === day) last.entries.push(entry);
		else days.push({ day, label: dayHeading(entry.at, now), entries: [entry] });
	}
	return days;
}

/** The API filters each record and linked revision for the current viewer. */
export function WorkspaceActivity({ workspaceId }: { workspaceId: string }) {
	const activity = useInfiniteQuery({
		...osQuery.osWorkspaces.workspaces.activity.infiniteOptions({
			input: (before: string | undefined) => ({
				workspaceId,
				kinds: [...WORKSPACE_ACTIVITY_KINDS],
				limit: 50,
				...(before ? { before } : {}),
			}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (page) => page.next ?? undefined,
		}),
		refetchInterval: 15_000,
	});
	const items = (activity.data?.pages ?? []).flatMap((page) => page.items);
	const tedis = useTediNames();
	// The workspace page already holds its file list and who is signed in.
	const files = useQuery({
		...canvasOutputsQueryOptions(workspaceId),
		staleTime: 60_000,
	});
	const viewer = useQuery({
		...workspacePresenceQueryOptions(workspaceId),
		staleTime: 60_000,
		retry: false,
	});
	const viewerId = viewer.data?.userId ?? null;
	// Names of the other people are one read, made only when one of them acted.
	const people = useQuery({
		...workspaceCollaboratorsQueryOptions(workspaceId),
		staleTime: 60_000,
		retry: false,
		enabled: items.some(
			(item) =>
				item.workspaceId === workspaceId &&
				item.actor.kind === "user" &&
				item.actor.id !== viewerId,
		),
	});
	const entries = workspaceActivityEntries(items, workspaceId, {
		viewerId,
		tedis,
		people: Object.fromEntries(
			(people.data?.collaborators ?? []).flatMap((person) => {
				const name = person.name ?? person.email;
				return name ? [[person.userId, name]] : [];
			}),
		),
		files: Object.fromEntries(
			(files.data?.items ?? []).map((file) => [file.id, file.title]),
		),
	});
	// Most recorded rows are chat steps, which this list leaves out, so a page
	// can hold nothing to show. Keep reading until there are lines to read.
	const pages = activity.data?.pages.length ?? 0;
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = activity;
	const wanting =
		entries.length < ACTIVITY_FIRST_VIEW &&
		pages < ACTIVITY_AUTO_PAGES &&
		hasNextPage &&
		!isFetchingNextPage;
	useEffect(() => {
		if (wanting) void fetchNextPage();
	}, [wanting, pages, fetchNextPage]);
	const lookingBack = entries.length === 0 && (wanting || isFetchingNextPage);
	return (
		<div className="grid min-w-0 gap-2 px-4 py-3">
			<Text as="h3" role="label">
				What happened in this workspace
			</Text>
			{activity.isError ? (
				<Text role="label" tone="error">
					Workspace activity could not be loaded. Try again later.
				</Text>
			) : activity.isPending || lookingBack ? (
				<LoadingArea label="Loading workspace activity…" />
			) : entries.length === 0 ? (
				<Text role="label" tone="secondary">
					{activity.hasNextPage
						? "Nothing recent you can see. Load more to look further back."
						: "Nothing has been recorded here yet."}
				</Text>
			) : (
				<div className="grid gap-2" data-workspace-activity-list="">
					{groupActivityByDay(entries).map((group) => (
						<section
							aria-label={group.label}
							className="grid gap-1"
							key={group.day}
						>
							<Text as="h4" role="caption" tone="secondary">
								{group.label}
							</Text>
							<ol className="m-0 grid list-none p-0">
								{group.entries.map((entry) => (
									<ActivityLine
										entry={entry}
										workspaceId={workspaceId}
										key={entry.id}
									/>
								))}
							</ol>
						</section>
					))}
				</div>
			)}
			{activity.hasNextPage && (
				<Button
					variant="secondary"
					loading={activity.isFetchingNextPage}
					onClick={() => void activity.fetchNextPage()}
				>
					Load more
				</Button>
			)}
			{activity.isSuccess ? (
				<Text as="p" className="m-0" role="caption" tone="secondary">
					Some activity can be missing: only recorded changes to files you can
					open are listed. Chat messages stay in their conversation.
				</Text>
			) : null}
		</div>
	);
}

function ActivityLine({
	entry,
	workspaceId,
}: {
	entry: WorkspaceActivityEntry;
	workspaceId: string;
}) {
	const Icon = DEEDS[entry.deed].icon;
	const title = entry.file ? sanitizeUntrustedText(entry.file.title) : null;
	return (
		<li
			className="flex min-w-0 items-start gap-2 border-b border-kumo-hairline py-2 last:border-b-0"
			data-activity-deed={entry.deed}
		>
			<IconFrame aria-hidden appearance="fill" className="mt-0.5" size="sm">
				<Icon size={14} />
			</IconFrame>
			<div className="grid min-w-0 flex-1 gap-0.5">
				<Text as="p" className="m-0 wrap-anywhere" role="label">
					{sanitizeUntrustedText(entry.lead)}
					{entry.file ? " " : ""}
					{entry.file?.href ? (
						<Link href={entry.file.href}>{title}</Link>
					) : (
						title
					)}
					{entry.tail}
				</Text>
				{entry.automaticRun ? (
					<WorkspaceAppTriggers
						workspaceId={workspaceId}
						gadgetId={entry.automaticRun.gadgetId}
						triggerId={entry.automaticRun.triggerId}
					/>
				) : null}
				<Text as="span" role="caption" tone="secondary">
					<time dateTime={entry.at} title={absoluteTime(entry.at)}>
						{relativeTime(entry.at)}
					</time>
				</Text>
			</div>
		</li>
	);
}
