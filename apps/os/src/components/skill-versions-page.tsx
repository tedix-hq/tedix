import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import { useState } from "react";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import {
	PageSection,
	SectionActions,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import {
	SkillVersionCompareDialog,
	SkillVersionSourceDialog,
} from "@/components/skill-version-dialogs";
import {
	SkillRollbackButton,
	SkillWorkflowDrafts,
	useSkillWorkflowDrafts,
} from "@/components/skill-workflow-drafts";
import {
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
} from "@/lib/os-query-options";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import {
	type SkillVersionRow,
	skillVersionRows,
	skillVersionRunLine,
	splitChangeNotes,
} from "@/lib/skill-versions";
import { cn } from "@/lib/utils";
import { absoluteTime, relativeTime } from "@/lib/time";

const WORKFLOW_FILE = "scripts/workflow.ts";

export function SkillVersionsPage() {
	useOsFormattingPreferences();
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const revisions = useQuery(skillRevisionsQueryOptions(skillId));
	const drafts = useSkillWorkflowDrafts(skillId);
	const entry = detail.isSuccess ? (detail.data.entry ?? null) : null;
	const rows = revisions.data
		? skillVersionRows({
				current: entry,
				revisions: revisions.data.revisions,
				drafts: drafts.data?.pages.flatMap((page) => page.entries) ?? [],
			})
		: [];
	return (
		<PageSection
			aria-labelledby="skill-versions-title"
			className="[overflow-wrap:anywhere]"
		>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-versions-title">Versions</SectionTitle>
					<SectionDescription>
						Each version of this skill, with what changed and how its runs went.
						The current version comes first.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{detail.isPending ? (
				<Text role="label" tone="secondary" className="m-0" aria-live="polite">
					Checking current version…
				</Text>
			) : !entry ? (
				<LoadError
					title={<>Could not check which version is current</>}
					error={detail.error}
					onRetry={() => {
						void detail.refetch();
					}}
					retrying={detail.isFetching}
					help="The Current mark appears once the skill's details load."
				/>
			) : null}
			<SkillWorkflowDrafts skillId={skillId} />
			{revisions.isPending ? <ListSkeleton /> : null}
			{revisions.isError ? (
				<LoadError
					title={
						revisions.data
							? "Versions could not refresh"
							: "Versions unavailable"
					}
					error={revisions.error}
					help={
						revisions.data
							? "Showing the versions loaded earlier; they may be out of date."
							: undefined
					}
					onRetry={() => void revisions.refetch()}
					retrying={revisions.isFetching}
				/>
			) : null}
			{revisions.data &&
				(rows.length === 0 ? (
					<Empty appearance="inline">
						<EmptyDescription>No versions have run yet.</EmptyDescription>
					</Empty>
				) : (
					<ul
						aria-label="Skill versions"
						className="m-0 grid list-none divide-y divide-kumo-hairline overflow-hidden rounded-lg border border-kumo-line p-0"
					>
						{rows.map((row) => (
							<VersionRow key={row.key} row={row} entry={entry} />
						))}
					</ul>
				))}
			{revisions.data?.mayBeTruncated ? (
				<Text role="label" tone="secondary" className="m-0">
					Run counts cover the latest{" "}
					{formatCount(revisions.data.sampledRunCount)} runs; older runs are not
					counted.
				</Text>
			) : null}
		</PageSection>
	);
}

function VersionRow({
	row,
	entry,
}: {
	row: SkillVersionRow;
	/** The skill as it is now; null while that is unknown. */
	entry: SkillEntry | null;
}) {
	const [open, setOpen] = useState<"source" | "compare" | null>(null);
	const observed = row.observed;
	const name = `Revision ${row.revision ?? "unknown"}`;
	const currentFiles =
		row.current && entry
			? {
					instructions: entry.content,
					automation: entry.files?.[WORKFLOW_FILE] ?? null,
				}
			: undefined;
	const notes = row.current
		? (entry?.revisionReasoning ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
		: [];
	const cleanup = row.current
		? splitChangeNotes(entry?.revisionReasoning).housekeeping.length
		: 0;
	const technical: [string, string][] = observed
		? [
				["Run used for this version's files", observed.runId],
				["Automation SHA-256", observed.workflowSourceSha256 ?? "not recorded"],
				["SKILL.md SHA-256", observed.skillDocSha256 ?? "not recorded"],
				[
					"Worker",
					`${observed.workerVersionTag ?? observed.workerVersionId ?? "legacy / not recorded"} · compatibility ${observed.executionCompatibilityHash ?? "not recorded"}`,
				],
				[
					"Runtime variants",
					`${observed.runtimeVariants.length} · drift ${observed.runtimeDriftBlocked ? "blocked" : observed.runtimeDriftObserved ? "observed" : "not observed"}`,
				],
				[
					"Runs",
					`${formatCount(observed.completedCount)} completed · ${formatCount(observed.failedCount)} failed · ${formatCount(observed.canceledCount)} canceled`,
				],
			]
		: [];
	return (
		<li
			data-version-row={row.revision ?? "unknown"}
			aria-current={row.current ? "true" : undefined}
			className={cn(
				"grid min-w-0 gap-2 border-l-2 border-l-transparent p-3 sm:p-4",
				row.current && "border-l-kumo-success bg-kumo-tint",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body">
					{name}
				</Text>
				{row.current ? <Badge variant="success">Current</Badge> : null}
				{row.testRunId ? (
					<Link variant="record" href={`/work/runs/${row.testRunId}`}>
						<Badge variant="outline">Test passed</Badge>
					</Link>
				) : null}
			</div>
			<Text
				as="p"
				className="m-0 line-clamp-2"
				tone={row.message ? undefined : "secondary"}
				title={row.message ?? undefined}
				data-version-message
			>
				{row.message ?? "No change note recorded."}
			</Text>
			<Collapsible className="grid min-w-0 gap-3">
				<Text
					as="p"
					role="label"
					tone="secondary"
					className="m-0"
					data-version-evidence
				>
					{row.changedAt && row.changedLabel ? (
						<>
							{row.changedLabel}{" "}
							<time
								dateTime={row.changedAt}
								title={absoluteTime(row.changedAt)}
							>
								{relativeTime(row.changedAt)}
							</time>
							{" · "}
						</>
					) : null}
					{skillVersionRunLine(observed)}
					{observed?.lastObservedAt ? (
						<>
							{" · last run "}
							<time
								dateTime={observed.lastObservedAt}
								title={absoluteTime(observed.lastObservedAt)}
							>
								{relativeTime(observed.lastObservedAt)}
							</time>
						</>
					) : null}
				</Text>
				<SectionActions>
					{currentFiles || observed ? (
						<Button
							size="sm"
							variant="outline"
							aria-label={`View source of ${name.toLowerCase()}`}
							onClick={() => setOpen("source")}
						>
							View source
						</Button>
					) : null}
					{observed && row.previousRunId ? (
						<Button
							size="sm"
							variant="outline"
							aria-label={`Compare ${name.toLowerCase()} with revision ${row.previousRevision}`}
							onClick={() => setOpen("compare")}
						>
							Compare with previous
						</Button>
					) : null}
					{!row.current && entry && observed && row.revision != null ? (
						<SkillRollbackButton
							baseline={entry}
							runId={observed.runId}
							revision={row.revision}
							label="Make current"
						/>
					) : null}
					{technical.length > 0 || notes.length > 0 ? (
						<CollapsibleDefaultTrigger>
							Technical details
						</CollapsibleDefaultTrigger>
					) : null}
				</SectionActions>
				<CollapsibleDefaultContent>
					<div className="grid min-w-0 gap-1 pb-2 [overflow-wrap:anywhere]">
						{technical.map(([label, value]) => (
							<Text as="span" role="label" tone="secondary" key={label}>
								{label}: {value}
							</Text>
						))}
						{observed?.runtimeVariants.map((variant) => (
							<Text
								as="span"
								role="label"
								tone="secondary"
								key={`${variant.runId}:${variant.executionEpoch}:${variant.manifestPath}`}
							>
								{variant.observation} · epoch {variant.executionEpoch} ·{" "}
								{variant.manifestPath} ·{" "}
								{variant.workerVersionTag ??
									variant.workerVersionId ??
									"worker unknown"}
							</Text>
						))}
						{notes.length > 0 ? (
							<Text as="span" role="label" tone="secondary">
								Notes on record ({formatCount(notes.length)}
								{cleanup > 0
									? `, ${formatCount(cleanup)} from automatic cleanup`
									: ""}
								):
							</Text>
						) : null}
						{notes.map((line, index) => (
							// Recorded notes can repeat word for word; position is their identity.
							<Text as="span" role="label" tone="secondary" key={index}>
								{line}
							</Text>
						))}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
			{open === "source" ? (
				<SkillVersionSourceDialog
					revision={row.revision}
					runId={observed?.runId ?? null}
					files={currentFiles}
					close={() => setOpen(null)}
				/>
			) : null}
			{open === "compare" && observed && row.previousRunId ? (
				<SkillVersionCompareDialog
					revision={row.revision}
					previousRevision={row.previousRevision}
					runId={observed.runId}
					previousRunId={row.previousRunId}
					close={() => setOpen(null)}
				/>
			) : null}
		</li>
	);
}
