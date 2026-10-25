import {
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ListWorkProjectContributorsResultSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import type * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	AGENT_HARNESS_LABEL,
	AgentStateBadge,
} from "@/components/work-agents-page";
import { workProjectContributorsQueryOptions } from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

function RetryButton({
	onRetry,
	fetching,
}: {
	onRetry: () => void;
	fetching: boolean;
}) {
	return (
		<Button
			size="sm"
			variant="secondary"
			aria-label="Retry loading contributors"
			disabled={fetching}
			onClick={() => {
				if (!fetching) onRetry();
			}}
		>
			{fetching ? "Retrying…" : "Retry"}
		</Button>
	);
}

type Contributor = z.output<
	typeof ListWorkProjectContributorsResultSchema
>["contributors"][number];

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}/i;

/**
 * The session name, only when it tells a person something the row does not
 * already say: never a raw session key, never a repeat of the Work item title.
 */
export function contributorSessionName(
	contributor: Pick<
		Contributor,
		"name" | "sessionKey" | "harness" | "workItemTitle"
	>,
): string | null {
	const name = contributor.name.trim();
	if (
		!name ||
		name === contributor.sessionKey ||
		name.startsWith(`${contributor.harness}:`) ||
		UUID_PREFIX.test(name)
	)
		return null;
	const title = contributor.workItemTitle?.trim().toLowerCase();
	const lower = name.toLowerCase();
	if (title && (title.startsWith(lower) || lower.startsWith(title)))
		return null;
	return name;
}

type ContributorGroupKey = "active" | "finished" | "inactive";

const CONTRIBUTOR_GROUP: Record<Contributor["state"], ContributorGroupKey> = {
	needs_you: "active",
	error: "active",
	working: "active",
	unknown: "active",
	done: "finished",
	ended: "finished",
	idle: "inactive",
};

const CONTRIBUTOR_GROUPS: ReadonlyArray<{
	key: ContributorGroupKey;
	title: string;
	/** Rows shown before "Show all"; active sessions are never hidden. */
	preview: number;
}> = [
	{ key: "active", title: "Active", preview: Number.POSITIVE_INFINITY },
	{ key: "finished", title: "Finished", preview: 10 },
	{ key: "inactive", title: ATTENTION_COPY.inactive, preview: 10 },
];

const URGENCY: Partial<Record<Contributor["state"], number>> = {
	needs_you: 0,
	error: 1,
	working: 2,
};

/** Waiting and blocked sessions first, then the most recent activity. */
function byUrgencyThenRecent(a: Contributor, b: Contributor) {
	return (
		(URGENCY[a.state] ?? 3) - (URGENCY[b.state] ?? 3) ||
		b.lastActivityAt.localeCompare(a.lastActivityAt)
	);
}

/** The group header already says Active, Finished or Inactive. */
const STATE_NEEDS_BADGE = new Set<Contributor["state"]>([
	"needs_you",
	"error",
	"unknown",
]);

function ContributorRow({
	contributor,
	now,
}: {
	contributor: Contributor;
	now: Date;
}) {
	useOsFormattingPreferences();
	const sessionName = contributorSessionName(contributor);
	const hasItem = Boolean(contributor.workItemId && contributor.workItemTitle);
	const active = CONTRIBUTOR_GROUP[contributor.state] === "active";
	const detail = hasItem
		? sessionName
		: active && contributor.state !== "error"
			? contributor.summary.trim() || null
			: null;
	return (
		<li
			data-contributor-state={contributor.state}
			className="flex min-w-0 items-center gap-x-3 gap-y-1 px-3 py-2 max-sm:flex-wrap"
		>
			<div className="grid min-w-0 flex-1 gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{hasItem ? (
						<Link
							variant="record"
							href={`/work/items/${contributor.workItemId}`}
							className="tap-target-y min-w-0 max-w-full truncate"
							title={contributor.workItemTitle ?? undefined}
						>
							{contributor.workItemTitle}
						</Link>
					) : (
						<Text
							as="span"
							role="body"
							tone={sessionName ? "strong" : "secondary"}
							className="max-w-full"
							truncate
							title={sessionName ?? undefined}
						>
							{sessionName ?? "No Work item"}
						</Text>
					)}
					{STATE_NEEDS_BADGE.has(contributor.state) ? (
						<AgentStateBadge
							state={contributor.state}
							lastSeenAt={contributor.lastActivityAt}
							reason={contributor.summary}
							now={now}
						/>
					) : null}
				</div>
				{detail ? (
					<Text as="span" role="label" tone="secondary" truncate title={detail}>
						{detail}
					</Text>
				) : null}
			</div>
			<Text
				as="span"
				role="label"
				tone="secondary"
				className="shrink-0 tabular-nums max-sm:basis-full"
			>
				{AGENT_HARNESS_LABEL[contributor.harness] ??
					ATTENTION_COPY.unknownSource}
				{contributor.attempts > 1 ? ` · ${contributor.attempts} runs` : ""}
				{" · "}
				<time
					dateTime={contributor.lastActivityAt}
					title={absoluteTime(contributor.lastActivityAt)}
				>
					{relativeTime(contributor.lastActivityAt, now)}
				</time>
			</Text>
		</li>
	);
}

function ContributorGroup({
	title,
	preview,
	contributors,
	now,
}: {
	title: string;
	preview: number;
	contributors: readonly Contributor[];
	now: Date;
}) {
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? contributors : contributors.slice(0, preview);
	const hidden = contributors.length - shown.length;
	return (
		<section aria-label={title} className="grid gap-2">
			<Text as="h3" role="label" tone="secondary" weight="medium">
				{title} · {contributors.length}
			</Text>
			<Collection aria-label={`${title} contributors`}>
				{shown.map((contributor) => (
					<ContributorRow
						key={contributor.sessionKey}
						contributor={contributor}
						now={now}
					/>
				))}
			</Collection>
			{hidden > 0 || expanded ? (
				<div>
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						{expanded ? "Show fewer" : `Show all ${contributors.length}`}
					</Button>
				</div>
			) : null}
		</section>
	);
}

/** Every local session that worked on a project, grouped by whether it is still active. */
export function WorkProjectContributors({
	projectId,
	now = new Date(),
}: {
	projectId: string;
	now?: Date;
}) {
	const query = useQuery(workProjectContributorsQueryOptions(projectId));
	const contributors = query.data?.contributors;
	// A failed refresh keeps the last rows; they are no longer verified current.
	const stale = Boolean(contributors) && query.isError;
	// cancelRefetch: false joins a read already in flight instead of restarting it.
	const retry = () => void query.refetch({ cancelRefetch: false });
	return (
		<PageSection aria-label="Contributors">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>
						Contributors
						{contributors && !stale ? ` (${contributors.length})` : ""}
					</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			{stale ? (
				<Alert variant="warning" data-contributors-stale="">
					<AlertTitle>Contributors could not be refreshed</AlertTitle>
					<AlertDescription>
						<p>
							{contributors?.length
								? "These sessions were last loaded "
								: "The last load found no sessions, "}
							<time
								dateTime={new Date(query.dataUpdatedAt).toISOString()}
								title={absoluteTime(
									new Date(query.dataUpdatedAt).toISOString(),
								)}
							>
								{relativeTime(new Date(query.dataUpdatedAt).toISOString(), now)}
							</time>
							{contributors?.length
								? " and may be out of date."
								: " and that is not confirmed now."}
						</p>
						<RetryButton onRetry={retry} fetching={query.isFetching} />
					</AlertDescription>
				</Alert>
			) : null}
			{contributors ? (
				contributors.length ? (
					<div className="grid gap-4" data-contributor-groups="">
						{CONTRIBUTOR_GROUPS.map((group) => {
							const rows = contributors
								.filter(
									(contributor) =>
										CONTRIBUTOR_GROUP[contributor.state] === group.key,
								)
								.sort(byUrgencyThenRecent);
							return rows.length ? (
								<ContributorGroup
									key={group.key}
									title={group.title}
									preview={group.preview}
									contributors={rows}
									now={now}
								/>
							) : null;
						})}
					</div>
				) : stale ? null : (
					<WorkEmpty
						title="No contributors"
						description="No sessions have worked on this project yet."
					/>
				)
			) : query.isError ? (
				<>
					<WorkReadFailure
						title="Contributors unavailable"
						error={query.error}
					/>
					<RetryButton onRetry={retry} fetching={query.isFetching} />
				</>
			) : (
				<WorkListSkeleton rows={2} label="Loading contributors" />
			)}
		</PageSection>
	);
}
