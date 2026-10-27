// Draft → test → switch on → roll back for a skill's automation, in the
// console. Every step calls the same API procedures the MCP tools use
// (skills.proposeWorkflowImprovement, skills.runWorkflow with certification,
// skills.activateWorkflowImprovement); nothing here decides on its own.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	SkillEntry,
	SkillRun,
	SkillRunSummary,
	SkillWorkflowToolCall,
} from "@tedix/api-contract/schemas/cognitive";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { errorDetails, errorMessage, orpcErrorCode } from "@/lib/orpc-error";
import {
	osQueryKeys,
	runArtifactsQueryOptions,
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
	skillRunStatusQueryOptions,
	skillRunToolCallsQueryOptions,
	skillRunsQueryOptions,
	skillWorkflowDraftsQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import { hasActiveSkillRun } from "@/lib/skill-runs-search";
import { useCanManageTedis } from "@/lib/tedi-permissions";
import { relativeTime } from "@/lib/time";

export const WORKFLOW_IMPROVEMENT_TAG = "workflow-improvement";
const WORKFLOW_FILE = "scripts/workflow.ts";
const TERMINAL = new Set(["completed", "failed", "canceled"]);

export type DraftSeed = {
	content: string;
	workflow: string;
	reason: string;
	/** Where the files came from, shown in the dialog. */
	origin?: string;
};

/**
 * The newest finished run of the live revision. The server grounds a draft
 * in exactly this run; without one it refuses with "Baseline advanced".
 */
export function findBaselineRun(
	runs: readonly SkillRunSummary[],
	revision: number,
): SkillRunSummary | null {
	const finished = runs
		.filter((run) => TERMINAL.has(run.status) && run.skillRevision === revision)
		.sort((a, b) =>
			(b.completedAt ?? b.startedAt ?? "").localeCompare(
				a.completedAt ?? a.startedAt ?? "",
			),
		);
	return finished[0] ?? null;
}

export function isBaselineConflict(error: unknown): boolean {
	return (
		orpcErrorCode(error) === "CONFLICT" ||
		/baseline advanced|execute the current revision/i.test(
			errorMessage(error, ""),
		)
	);
}

export type CertificationVerdict = {
	state: "running" | "passed" | "blocked" | "failed" | "none";
	title: string;
	detail: string;
};

function callLabel(call: SkillWorkflowToolCall): string {
	const name =
		call.namespace && call.method
			? `${call.namespace}.${call.method}`
			: call.name;
	return call.attempt && call.attempt > 1
		? `${name} (attempt ${call.attempt})`
		: name;
}

function callError(call: SkillWorkflowToolCall): string {
	const error = call.error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return "";
}

/**
 * Plain-English reading of a test run, following the same rule the server
 * applies at activation: the run must complete, report certification passed,
 * and have no failed call at all.
 */
export function describeCertification(
	run: SkillRun | null | undefined,
	artifacts: readonly { path: string; outcome: string }[] = [],
	toolCalls: readonly SkillWorkflowToolCall[] = [],
): CertificationVerdict {
	if (!run)
		return {
			state: "none",
			title: "Not tested yet",
			detail: "Test the draft before switching it on.",
		};
	if (!TERMINAL.has(run.status))
		return {
			state: "running",
			title: "Testing…",
			detail: run.startedAt
				? `Started ${relativeTime(run.startedAt)}. This page refreshes on its own.`
				: "Waiting for the run to start.",
		};
	if (run.status !== "completed")
		return {
			state: "failed",
			title: run.status === "failed" ? "Test failed" : "Test was canceled",
			detail: run.error
				? `The run stopped with: ${run.error}`
				: "The run did not finish. Fix the draft and test again.",
		};
	const failedCalls = toolCalls.filter((call) => call.outcome === "failure");
	const failedArtifacts = artifacts.filter(
		(artifact) =>
			artifact.outcome === "failure" &&
			/(?:^|\/)calls\/(?:run|compensate)\/\d+\.json$/.test(artifact.path),
	);
	if (failedCalls.length > 0 || failedArtifacts.length > 0) {
		const named = failedCalls.map(
			(call) =>
				`${callLabel(call)}${callError(call) ? `: ${callError(call)}` : ""}`,
		);
		const count = Math.max(failedCalls.length, failedArtifacts.length);
		return {
			state: "blocked",
			title: `Test finished, but ${count === 1 ? "one call" : `${count} calls`} failed`,
			detail: `${
				named.length > 0
					? `Failed: ${named.join("; ")}. `
					: `Failed call receipts: ${failedArtifacts.map((artifact) => artifact.path).join(", ")}. `
			}Tedix only switches on a draft whose test had no failed call, even when the workflow reported itself as passed. Fix the draft and test again.`,
		};
	}
	const result =
		run.result && typeof run.result === "object" && !Array.isArray(run.result)
			? (run.result as Record<string, unknown>)
			: null;
	const certification =
		result?.certification &&
		typeof result.certification === "object" &&
		!Array.isArray(result.certification)
			? (result.certification as Record<string, unknown>)
			: null;
	const passed =
		certification?.status === "passed" ||
		certification?.passed === true ||
		certification?.overallStatus === "passed";
	if (passed)
		return {
			state: "passed",
			title: "Test passed",
			detail: `${toolCalls.length === 0 ? "No call" : `${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"}, none`} failed and the workflow reported certification passed. You can switch this draft on.`,
		};
	return {
		state: "blocked",
		title: certification
			? "Test finished without passing"
			: "Test finished without a certification result",
		detail: certification
			? "The workflow reported certification as not passed. Read the run, fix the draft and test again."
			: "A test run must return { certification: { passed: true } } from the workflow. This one returned nothing Tedix can check.",
	};
}

/** Baseline + draft rows for one skill. Owner/admin controls only. */
export function SkillWorkflowDrafts({ skillId }: { skillId: string }) {
	const canManage = useCanManageTedis();
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const drafts = useQuery({
		...skillWorkflowDraftsQueryOptions(),
		enabled: canManage,
		select: (data) =>
			data.entries.filter(
				(entry) =>
					entry.sourceSkillId === skillId &&
					entry.tags?.includes(WORKFLOW_IMPROVEMENT_TAG),
			),
	});
	const [seed, setSeed] = useState<DraftSeed | null>(null);
	const [activated, setActivated] = useState<{
		revision: number;
		title: string;
	} | null>(null);
	const baseline = detail.data?.entry ?? null;
	const executable = Boolean(baseline?.files?.[WORKFLOW_FILE]);
	if (!canManage || !baseline || !executable) return null;
	return (
		<section
			className="grid gap-3 rounded border p-3"
			aria-labelledby="skill-workflow-drafts-title"
			data-skill-workflow-drafts
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Text
					as="h3"
					id="skill-workflow-drafts-title"
					weight="semibold"
					className="m-0"
				>
					Drafts
				</Text>
				<Button
					size="sm"
					variant="outline"
					className="min-h-11 sm:min-h-8"
					onClick={() =>
						setSeed({
							content: baseline.content,
							workflow: baseline.files?.[WORKFLOW_FILE] ?? "",
							reason: "",
						})
					}
				>
					New draft
				</Button>
			</div>
			<Text role="label" tone="secondary" className="m-0">
				A draft is tested with a dry run that does not change the live skill or
				its schedule. A draft whose test passed can be switched on; the live
				version moves to revision {baseline.revision + 1}.
			</Text>
			{drafts.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Drafts could not be read</AlertTitle>
					<AlertDescription>{errorMessage(drafts.error)}</AlertDescription>
					<Button
						variant="outline"
						className="mt-2 min-h-11 w-fit"
						onClick={() => void drafts.refetch()}
					>
						Retry drafts
					</Button>
				</Alert>
			) : null}
			{activated ? (
				<Alert variant="info">
					<AlertTitle>
						Switched on: revision {activated.revision} is live
					</AlertTitle>
					<AlertDescription>
						Draft {activated.title} is archived. The previous version stays in
						the list below so you can roll back.
					</AlertDescription>
				</Alert>
			) : null}
			{drafts.data?.length === 0 ? (
				<Text role="label" tone="secondary" className="m-0">
					No drafts yet.
				</Text>
			) : null}
			{drafts.data?.map((draft) => (
				<SkillWorkflowDraftRow
					key={draft.id}
					draft={draft}
					baseline={baseline}
					onActivated={(revision) =>
						setActivated({ revision, title: draft.title })
					}
				/>
			))}
			{seed ? (
				<SkillWorkflowDraftDialog
					baseline={baseline}
					seed={seed}
					close={() => setSeed(null)}
				/>
			) : null}
		</section>
	);
}

function SkillWorkflowDraftRow({
	draft,
	baseline,
	onActivated,
}: {
	draft: SkillEntry;
	baseline: SkillEntry;
	onActivated: (revision: number) => void;
}) {
	const queryClient = useQueryClient();
	const stale = draft.sourceRevision !== baseline.revision;
	const runs = useQuery({
		...skillRunsQueryOptions(draft.id, undefined, 5),
		refetchInterval: (query) =>
			hasActiveSkillRun(query.state.data?.runs ?? []) ? 5_000 : false,
	});
	const latest = [...(runs.data?.runs ?? [])].sort((a, b) =>
		(b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
	)[0];
	const run = useQuery({
		...skillRunStatusQueryOptions(latest?.id ?? ""),
		enabled: Boolean(latest),
		refetchInterval: (query) =>
			query.state.data && !TERMINAL.has(query.state.data.status)
				? 5_000
				: false,
	});
	const finished = Boolean(run.data && TERMINAL.has(run.data.status));
	const artifacts = useQuery({
		...runArtifactsQueryOptions(latest?.id ?? ""),
		enabled: finished,
	});
	const toolCalls = useQuery({
		...skillRunToolCallsQueryOptions(latest?.id ?? ""),
		enabled: finished,
	});
	const verdict = describeCertification(
		run.data,
		artifacts.data?.artifacts,
		toolCalls.data?.toolCalls,
	);
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillRuns() }),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() }),
			queryClient.invalidateQueries({
				queryKey: skillRevisionsQueryOptions(baseline.id).queryKey,
			}),
		]);
	const test = useMutation({
		mutationFn: () =>
			osApi.skills.runWorkflow({
				skillId: draft.id,
				tediId: draft.tediId ?? baseline.tediId ?? "",
				certification: true,
				confirmDestructive: true,
				idempotencyKey: crypto.randomUUID(),
				reason: `Test run of draft ${draft.id} from the Tedix OS versions page`,
			}),
		onSuccess: refresh,
	});
	const activate = useMutation({
		mutationFn: () =>
			osApi.skills.activateWorkflowImprovement({
				id: draft.id,
				certificationRunId: latest!.id,
				reason: `Switched on from the Tedix OS versions page after test run ${latest!.id}`,
			}),
		onSuccess: (result) => {
			onActivated(result.baseline.revision);
			return refresh();
		},
	});
	const busy = test.isPending || activate.isPending;
	const alertVariant =
		verdict.state === "passed"
			? "info"
			: verdict.state === "none" || verdict.state === "running"
				? "default"
				: "warning";
	return (
		<div
			className="grid gap-2 rounded border p-3 [overflow-wrap:anywhere]"
			aria-label={`Draft ${draft.title}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body">
					{draft.title}
				</Text>
				<Badge variant="secondary">
					Based on revision {draft.sourceRevision ?? "unknown"}
				</Badge>
				{stale ? <Badge variant="outline">Out of date</Badge> : null}
			</div>
			{draft.revisionReasoning ? (
				<Text role="label" tone="secondary" className="m-0">
					{draft.revisionReasoning.split("\n")[0]}
				</Text>
			) : null}
			{activate.isSuccess ? null : stale ? (
				<Alert variant="warning">
					<AlertTitle>This draft cannot be switched on</AlertTitle>
					<AlertDescription>
						It was based on revision {draft.sourceRevision ?? "unknown"}, but
						the live version is now revision {baseline.revision}. Make a new
						draft from the live version.
					</AlertDescription>
				</Alert>
			) : (
				<Alert variant={alertVariant}>
					<AlertTitle>{verdict.title}</AlertTitle>
					<AlertDescription>{verdict.detail}</AlertDescription>
				</Alert>
			)}
			{test.isError ? (
				<Text role="label" tone="error" className="m-0">
					Test could not start: {errorMessage(test.error)}
				</Text>
			) : null}
			{activate.isError ? (
				<Text role="label" tone="error" className="m-0">
					Could not switch on: {errorMessage(activate.error)}
					{errorDetails(activate.error).map((line) => (
						<span key={line} className="block">
							{line}
						</span>
					))}
				</Text>
			) : null}
			{!stale && !activate.isSuccess ? (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						className="min-h-11 sm:min-h-8"
						disabled={busy || verdict.state === "running"}
						onClick={() => test.mutate()}
					>
						{test.isPending
							? "Starting test…"
							: verdict.state === "none"
								? "Test this draft (dry run)"
								: "Test again (dry run)"}
					</Button>
					<Button
						size="sm"
						className="min-h-11 sm:min-h-8"
						disabled={busy || verdict.state !== "passed"}
						onClick={() => activate.mutate()}
					>
						{activate.isPending ? "Switching on…" : "Switch on"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * Roll back = a draft made from the files an earlier run pinned, then the
 * same test and switch-on path. Nothing changes until that draft is switched on.
 */
export function SkillRollbackButton({
	baseline,
	runId,
	revision,
}: {
	baseline: SkillEntry;
	runId: string;
	revision: number;
}) {
	const canManage = useCanManageTedis();
	const [seed, setSeed] = useState<DraftSeed | null>(null);
	const load = useMutation({
		mutationFn: async () => {
			const pinned = await osApi.skills.getWorkflowRevision({
				runId,
				includeSource: true,
			});
			if (!pinned.workflowSource)
				throw new Error(
					`Run ${runId} did not keep the automation source of revision ${revision}, so it cannot be restored from here.`,
				);
			return pinned;
		},
		onSuccess: (pinned) =>
			setSeed({
				content: pinned.skillDoc ?? baseline.content,
				workflow: pinned.workflowSource ?? "",
				reason: `Roll back to revision ${revision} (files pinned by run ${runId})`,
				origin: `restores revision ${revision}`,
			}),
	});
	if (!canManage || !baseline.files?.[WORKFLOW_FILE]) return null;
	return (
		<>
			<Button
				size="sm"
				variant="outline"
				className="min-h-11 w-fit sm:min-h-8"
				disabled={load.isPending}
				onClick={() => load.mutate()}
			>
				{load.isPending
					? "Reading files…"
					: `Roll back to revision ${revision}`}
			</Button>
			{load.isError ? (
				<Text role="label" tone="error" className="m-0">
					{errorMessage(load.error)}
				</Text>
			) : null}
			{seed ? (
				<SkillWorkflowDraftDialog
					baseline={baseline}
					seed={seed}
					close={() => setSeed(null)}
				/>
			) : null}
		</>
	);
}

/**
 * Propose a draft of a skill's automation. Grounds it in the newest finished
 * run of the live revision; when there is none, offers the dry run of the
 * current version that creates it.
 */
export function SkillWorkflowDraftDialog({
	baseline,
	seed,
	close,
	afterSave,
}: {
	baseline: SkillEntry;
	seed: DraftSeed;
	close: () => void;
	/** Shown under the saved receipt, e.g. a link to where the draft is tested. */
	afterSave?: ReactNode;
}) {
	const queryClient = useQueryClient();
	const [content, setContent] = useState(seed.content);
	const [workflow, setWorkflow] = useState(seed.workflow);
	const [reason, setReason] = useState(seed.reason);
	const runs = useQuery({
		...skillRunsQueryOptions(baseline.id, undefined, 50),
		refetchInterval: (query) =>
			hasActiveSkillRun(query.state.data?.runs ?? []) ? 5_000 : false,
	});
	const baselineRun = findBaselineRun(runs.data?.runs ?? [], baseline.revision);
	const currentRunning = (runs.data?.runs ?? []).some(
		(run) =>
			!TERMINAL.has(run.status) && run.skillRevision === baseline.revision,
	);
	const inferredTedi =
		baseline.tediId ?? runs.data?.runs.find((run) => run.tediId)?.tediId ?? "";
	const [chosenTedi, setChosenTedi] = useState("");
	const tediId = chosenTedi || inferredTedi;
	const roster = useQuery({
		...tediRosterQueryOptions(100),
		enabled: runs.isSuccess && !inferredTedi,
	});
	const runCurrent = useMutation({
		mutationFn: () =>
			osApi.skills.runWorkflow({
				skillId: baseline.id,
				tediId,
				certification: true,
				confirmDestructive: true,
				idempotencyKey: crypto.randomUUID(),
				reason: `Dry run of revision ${baseline.revision} so a draft can be compared to it (Tedix OS)`,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillRuns() }),
	});
	const propose = useMutation({
		mutationFn: async () => {
			if (!baselineRun)
				throw Object.assign(new Error("Baseline advanced"), {
					code: "CONFLICT",
				});
			return osApi.skills.proposeWorkflowImprovement({
				baselineRunId: baselineRun.id,
				reason,
				content,
				files: { ...(baseline.files ?? {}), [WORKFLOW_FILE]: workflow },
			});
		},
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() }),
	});
	const needsBaseline =
		runs.isSuccess && (!baselineRun || isBaselineConflict(propose.error));
	const unchanged = workflow === (baseline.files?.[WORKFLOW_FILE] ?? "");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>Draft changes to {baseline.title}</DialogTitle>
					<DialogDescription>
						Based on revision {baseline.revision}
						{seed.origin ? ` · ${seed.origin}` : ""}. Saving creates a draft you
						can test and switch on; the live version does not change.
					</DialogDescription>
				</DialogHeader>
				{propose.isSuccess ? (
					<div className="grid gap-2">
						<Alert variant="info">
							<AlertTitle>
								Draft saved: {propose.data.proposal.title}
							</AlertTitle>
							<AlertDescription>
								{propose.data.validation.valid
									? "Next: test it with a dry run, then switch it on."
									: `The draft has validation problems: ${propose.data.validation.errors.map((issue) => issue.message).join("; ")}`}
							</AlertDescription>
						</Alert>
						{afterSave}
					</div>
				) : (
					<div className="grid max-h-[60vh] gap-3 overflow-y-auto">
						<label className="grid gap-1 text-sm">
							Instructions
							<Textarea
								aria-label="Draft skill instructions"
								rows={8}
								value={content}
								maxLength={200_000}
								onChange={(event) => setContent(event.target.value)}
							/>
						</label>
						<label className="grid gap-1 text-sm">
							Automation source
							<Textarea
								aria-label="Draft automation source"
								rows={10}
								value={workflow}
								maxLength={500_000}
								onChange={(event) => setWorkflow(event.target.value)}
							/>
						</label>
						<label className="grid gap-1 text-sm">
							Why this change
							<Textarea
								aria-label="Draft change reason"
								rows={2}
								value={reason}
								maxLength={2000}
								onChange={(event) => setReason(event.target.value)}
							/>
						</label>
						{runs.isError ? (
							<Alert variant="warning">
								<AlertTitle>Run history could not be read</AlertTitle>
								<AlertDescription>
									{errorMessage(runs.error)} A draft needs a finished run of
									revision {baseline.revision} to compare against.
								</AlertDescription>
								<Button
									variant="outline"
									className="mt-2 min-h-11 w-fit"
									onClick={() => void runs.refetch()}
								>
									Retry run history
								</Button>
							</Alert>
						) : null}
						{needsBaseline ? (
							<Alert variant="warning">
								<AlertTitle>Run the current version first (dry run)</AlertTitle>
								<AlertDescription>
									{currentRunning
										? `Revision ${baseline.revision} is running now. When it finishes, save the draft again.`
										: `Revision ${baseline.revision} has no finished run yet, so Tedix has nothing to compare the draft to. A dry run does not change the live skill.`}
								</AlertDescription>
								{!inferredTedi ? (
									<Select
										value={chosenTedi}
										onValueChange={(value) => value && setChosenTedi(value)}
									>
										<SelectTrigger
											aria-label="Run the current version as"
											className="mt-2"
										>
											<SelectValue placeholder="Run as which tedi?" />
										</SelectTrigger>
										<SelectContent>
											{(roster.data?.data ?? []).map((tedi) => (
												<SelectItem key={tedi.id} value={tedi.id}>
													{tedi.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : null}
								<Button
									variant="outline"
									className="mt-2 min-h-11 w-fit"
									disabled={!tediId || runCurrent.isPending || currentRunning}
									onClick={() => runCurrent.mutate()}
								>
									{runCurrent.isPending
										? "Starting…"
										: currentRunning
											? "Running…"
											: "Run the current version first (dry run)"}
								</Button>
								{runCurrent.isError ? (
									<Text role="label" tone="error" className="m-0 mt-1">
										{errorMessage(runCurrent.error)}
									</Text>
								) : null}
							</Alert>
						) : null}
						{propose.isError && !isBaselineConflict(propose.error) ? (
							<Alert variant="destructive">
								<AlertTitle>The draft could not be saved</AlertTitle>
								<AlertDescription>
									{errorMessage(propose.error)}
									{errorDetails(propose.error).map((line) => (
										<span key={line} className="block">
											{line}
										</span>
									))}
								</AlertDescription>
							</Alert>
						) : null}
					</div>
				)}
				{!propose.isSuccess && unchanged ? (
					<Text role="label" tone="secondary" className="m-0">
						Change the automation source first; a draft identical to the live
						version is refused.
					</Text>
				) : null}
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Close
					</Button>
					{!propose.isSuccess ? (
						<Button
							disabled={
								propose.isPending ||
								!runs.isSuccess ||
								!baselineRun ||
								unchanged ||
								!content.trim() ||
								reason.trim().length < 8
							}
							onClick={() => propose.mutate()}
						>
							{propose.isPending ? "Saving draft…" : "Save draft"}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
