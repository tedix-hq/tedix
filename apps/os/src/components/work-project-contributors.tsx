import {
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { useQuery } from "@tanstack/react-query";
import type { ListWorkProjectContributorsResultSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import type * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
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

function ContributorRow({
	contributor,
	now,
}: {
	contributor: Contributor;
	now: Date;
}) {
	useOsFormattingPreferences();
	return (
		<li
			data-contributor-state={contributor.state}
			className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
		>
			<Badge variant="outline" className="shrink-0">
				{AGENT_HARNESS_LABEL[contributor.harness] ??
					ATTENTION_COPY.unknownSource}
			</Badge>
			<AgentStateBadge
				state={contributor.state}
				lastSeenAt={contributor.lastActivityAt}
				reason={contributor.summary}
				now={now}
			/>
			<Text
				as="span"
				role="body"
				tone="strong"
				className="min-w-0 max-w-[40%] truncate"
				title={contributor.name}
			>
				{contributor.name}
			</Text>
			{contributor.workItemId && contributor.workItemTitle ? (
				<Link
					variant="record"
					href={`/work/items/${contributor.workItemId}`}
					className="tap-target-y min-w-0 flex-1 truncate max-sm:basis-full"
					title={contributor.workItemTitle}
				>
					{contributor.workItemTitle}
				</Link>
			) : (
				<Text
					as="span"
					role="body"
					tone="secondary"
					className="min-w-0 flex-1 truncate max-sm:basis-full"
					title={contributor.summary}
				>
					{contributor.summary}
				</Text>
			)}
			{contributor.attempts > 0 ? (
				<Text as="span" role="label" tone="secondary" className="shrink-0">
					{contributor.attempts === 1
						? "1 attempt"
						: `${contributor.attempts} attempts`}
				</Text>
			) : null}
			<Text as="span" role="label" tone="secondary" className="shrink-0">
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

/** Every Claude Code and Codex session that worked on a project, active first. */
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
					<Collection aria-label="Project contributors">
						{contributors.map((contributor) => (
							<ContributorRow
								key={contributor.sessionKey}
								contributor={contributor}
								now={now}
							/>
						))}
					</Collection>
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
