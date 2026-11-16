// Read-only looks at a skill version's files: the source of one version, and
// what changed between two versions that both ran.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	type DiffLine,
	buildUnifiedDiff,
	collapseDiff,
} from "@/lib/diff/diff-model";
import {
	skillWorkflowRevisionCompareQueryOptions,
	skillWorkflowRevisionSourceQueryOptions,
} from "@/lib/os-query-options";
import { cn } from "@/lib/utils";

export type SkillVersionFiles = {
	instructions: string | null;
	automation: string | null;
};

function SourceBlock({ label, text }: { label: string; text: string | null }) {
	return (
		<section className="grid min-w-0 gap-1" aria-label={label}>
			<Text as="h3" weight="semibold" className="m-0">
				{label}
			</Text>
			{text ? (
				<pre
					// Scrollable text must be reachable by keyboard.
					tabIndex={0}
					className="m-0 max-h-72 overflow-auto rounded-lg border border-kumo-line bg-kumo-base p-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
				>
					{text}
				</pre>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					Not kept for this version.
				</Text>
			)}
		</section>
	);
}

/** The instructions and automation of one version. */
export function SkillVersionSourceDialog({
	revision,
	runId,
	files,
	close,
}: {
	revision: number | null;
	/** A run of this version; its pinned files are read when `files` is absent. */
	runId: string | null;
	/** Files already on the page (the current version). */
	files?: SkillVersionFiles;
	close: () => void;
}) {
	const pinned = useQuery({
		...skillWorkflowRevisionSourceQueryOptions(runId ?? ""),
		enabled: !files && Boolean(runId),
	});
	const shown: SkillVersionFiles | null =
		files ??
		(pinned.data
			? {
					instructions: pinned.data.skillDoc ?? null,
					automation: pinned.data.workflowSource ?? null,
				}
			: null);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>Source of revision {revision ?? "unknown"}</DialogTitle>
					<DialogDescription>
						{files
							? "The instructions and automation in use now."
							: "The instructions and automation this version ran with."}
					</DialogDescription>
				</DialogHeader>
				<div className="grid max-h-[60vh] min-w-0 gap-3 overflow-y-auto">
					{!shown && pinned.isPending ? <ListSkeleton /> : null}
					{pinned.isError ? (
						<LoadError
							title="Source unavailable"
							error={pinned.error}
							onRetry={() => void pinned.refetch()}
							retrying={pinned.isFetching}
						/>
					) : null}
					{shown ? (
						<>
							<SourceBlock label="Instructions" text={shown.instructions} />
							<SourceBlock label="Automation" text={shown.automation} />
						</>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

const DIFF_TONE: Record<DiffLine["kind"], string> = {
	added: "border-kumo-success bg-kumo-success-tint",
	removed: "border-kumo-danger bg-kumo-danger-tint",
	context: "border-transparent",
};
const DIFF_SIGN: Record<DiffLine["kind"], string> = {
	added: "+",
	removed: "−",
	context: " ",
};
const COLLAPSED_LINES = 200;

function ChangedFile({
	label,
	before,
	after,
}: {
	label: string;
	before: string | null;
	after: string | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const model = useMemo(
		() =>
			before == null || after == null ? null : buildUnifiedDiff(before, after),
		[before, after],
	);
	const collapsed = model
		? collapseDiff(model, expanded ? Number.POSITIVE_INFINITY : COLLAPSED_LINES)
		: null;
	return (
		<section className="grid min-w-0 gap-1" aria-label={label}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="h3" weight="semibold" className="m-0">
					{label}
				</Text>
				{model && model.status !== "unchanged" ? (
					<>
						<Badge variant="success">{`${model.additions} ${model.additions === 1 ? "line" : "lines"} added`}</Badge>
						<Badge variant="error">{`${model.deletions} ${model.deletions === 1 ? "line" : "lines"} removed`}</Badge>
					</>
				) : null}
			</div>
			{!model || !collapsed ? (
				<Text role="label" tone="secondary" className="m-0">
					Not kept for one of these versions, so it cannot be compared.
				</Text>
			) : model.status === "unchanged" ? (
				<Text role="label" tone="secondary" className="m-0">
					No change.
				</Text>
			) : (
				<>
					<div
						// Scrollable text must be reachable by keyboard.
						tabIndex={0}
						role="group"
						aria-label={`${label} changes`}
						className="max-h-72 overflow-auto rounded-lg border border-kumo-line bg-kumo-base font-mono text-xs leading-5"
					>
						{collapsed.hunks.map((hunk) => (
							<div key={hunk.key}>
								<div className="bg-kumo-tint px-2 py-px text-kumo-subtle">
									From line {hunk.modifiedStart}
								</div>
								{hunk.lines.map((line, index) => (
									<div
										// Lines of one hunk have no identity but their position.
										key={`${hunk.key}-${index}`}
										className={cn(
											"flex gap-2 border-l-2 px-2 py-px whitespace-pre-wrap [overflow-wrap:anywhere]",
											DIFF_TONE[line.kind],
										)}
									>
										<span className="w-3 shrink-0 select-none">
											{DIFF_SIGN[line.kind]}
										</span>
										<span className="min-w-0">{line.text}</span>
									</div>
								))}
							</div>
						))}
					</div>
					{collapsed.hiddenLines > 0 ? (
						<Button
							size="sm"
							variant="ghost"
							className="justify-self-start"
							onClick={() => setExpanded(true)}
						>
							Show {collapsed.hiddenLines} more lines
						</Button>
					) : null}
				</>
			)}
		</section>
	);
}

/** What changed from the previous version that ran to this one. */
export function SkillVersionCompareDialog({
	revision,
	previousRevision,
	runId,
	previousRunId,
	close,
}: {
	revision: number | null;
	previousRevision: number | null;
	runId: string;
	previousRunId: string;
	close: () => void;
}) {
	const compared = useQuery(
		skillWorkflowRevisionCompareQueryOptions(previousRunId, runId),
	);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>
						Revision {revision ?? "unknown"} compared with revision{" "}
						{previousRevision ?? "unknown"}
					</DialogTitle>
					<DialogDescription>
						Lines marked + were added in revision {revision ?? "unknown"}; lines
						marked − were removed.
					</DialogDescription>
				</DialogHeader>
				<div className="grid max-h-[60vh] min-w-0 gap-3 overflow-y-auto">
					{compared.isPending ? <ListSkeleton /> : null}
					{compared.isError ? (
						<LoadError
							title="Comparison unavailable"
							error={compared.error}
							onRetry={() => void compared.refetch()}
							retrying={compared.isFetching}
						/>
					) : null}
					{compared.data ? (
						<>
							<ChangedFile
								label="Instructions"
								before={compared.data.baselineSkillDoc ?? null}
								after={compared.data.candidateSkillDoc ?? null}
							/>
							<ChangedFile
								label="Automation"
								before={compared.data.baselineSource ?? null}
								after={compared.data.candidateSource ?? null}
							/>
						</>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
