import { useQuery } from "@tanstack/react-query";
import type {
	SkillEntry,
	SkillRunSummary,
} from "@tedix/api-contract/schemas/cognitive";
import { useMemo } from "react";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	type RecordedStepEvidence,
	type SkillAnatomyStep,
	deriveSkillAnatomy,
	recordedStepsByName,
} from "@/lib/skill-anatomy";
import { workflowRunInspectQueryOptions } from "@/lib/os-query-options";
import { formatDurationMs } from "@/lib/time";

const TERMINAL = new Set(["completed", "failed", "canceled"]);

const KIND_LABEL: Record<SkillAnatomyStep["kind"], string> = {
	action: "Step",
	sleep: "Sleep",
	sleep_until: "Sleep until",
	wait: "Wait",
	operation: "Call",
	instruction: "Instruction",
};

const KIND_SENTENCE: Record<SkillAnatomyStep["kind"], string> = {
	action:
		"A durable unit of work. The engine retries it on failure and keeps its result.",
	sleep: "A durable pause; the run resumes after the delay.",
	sleep_until: "A durable pause until a set time.",
	wait: "Waits for an event — an approval, a signal, a reply — before continuing.",
	operation: "A call on the workflow's step object.",
	instruction: "A written step the assistant follows.",
};

function runHref(runId: string) {
	return `/work/runs/${runId}`;
}

/** The newest finished run — the closest thing to "what it did last time". */
function evidenceRun(runs: readonly SkillRunSummary[]) {
	return (
		runs.find((run) => run.status === "completed") ??
		runs.find((run) => TERMINAL.has(run.status)) ??
		null
	);
}

function StepFacts({ step }: { step: SkillAnatomyStep }) {
	const facts: string[] = [];
	facts.push(`${step.sourcePath}:${step.line}`);
	if (step.timeout) facts.push(`timeout ${step.timeout}`);
	if (step.retryLimit != null)
		facts.push(
			step.retryLimit <= 0 ? "no retries" : `retries up to ${step.retryLimit}×`,
		);
	if (step.eventType) facts.push(`event "${step.eventType}"`);
	if (step.sleepDuration) facts.push(`for ${step.sleepDuration}`);
	if (step.hasRollback) facts.push("rollback handler");
	if (step.sensitiveOutput) facts.push("output marked sensitive");
	return (
		<Text role="label" tone="mono-secondary" className="m-0 wrap-anywhere">
			{facts.join(" · ")}
		</Text>
	);
}

function StepEvidence({
	step,
	recorded,
	run,
	loading,
}: {
	step: SkillAnatomyStep;
	recorded: RecordedStepEvidence | undefined;
	run: SkillRunSummary | null;
	loading: boolean;
}) {
	if (step.dynamicName)
		return (
			<Text role="label" tone="secondary" className="m-0">
				Named when the run executes — matched runs list it under its recorded
				name.{" "}
				{run ? (
					<Link href={runHref(run.id)}>See the latest run</Link>
				) : (
					"No runs recorded yet."
				)}
			</Text>
		);
	if (loading)
		return (
			<Text role="label" tone="secondary" className="m-0">
				Reading the latest run…
			</Text>
		);
	if (recorded && run)
		return (
			<Text role="label" tone="secondary" className="m-0">
				Recorded {recorded.records > 1 ? `${recorded.records}× ` : ""}in the
				latest run
				{recorded.durationMs
					? `, ${formatDurationMs(recorded.durationMs)}`
					: ""}
				{recorded.outcome === "failure"
					? ", ended in failure"
					: recorded.outcome === "pending"
						? ", still in progress"
						: ""}
				. <Link href={runHref(run.id)}>See the run</Link>
			</Text>
		);
	if (run)
		return (
			<Text role="label" tone="secondary" className="m-0">
				Not recorded in the latest run — it may be skipped by a branch or named
				differently at run time. <Link href={runHref(run.id)}>See the run</Link>
			</Text>
		);
	return (
		<Text role="label" tone="secondary" className="m-0">
			No runs recorded yet.
		</Text>
	);
}

function AnatomyStepRow({
	step,
	index,
	recorded,
	run,
	loading,
}: {
	step: SkillAnatomyStep;
	index: number;
	recorded: RecordedStepEvidence | undefined;
	run: SkillRunSummary | null;
	loading: boolean;
}) {
	return (
		<li className="min-w-0">
			<Collapsible>
				<CollapsibleDefaultTrigger className="w-full">
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="tabular-nums"
						>
							{index + 1}.
						</Text>
						<Text
							as="span"
							role="control"
							tone={step.dynamicName ? "mono-secondary" : "mono"}
							className="min-w-0 wrap-anywhere"
						>
							{step.label}
						</Text>
						<Badge variant="secondary">{KIND_LABEL[step.kind]}</Badge>
						{step.dynamicName ? (
							<Badge variant="outline">named at run time</Badge>
						) : null}
						{step.repeated ? <Badge variant="outline">in a loop</Badge> : null}
						{step.conditional ? (
							<Badge variant="outline">in a branch</Badge>
						) : null}
						{step.parallel ? <Badge variant="outline">parallel</Badge> : null}
					</span>
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					<div className="grid min-w-0 gap-2 px-2 pt-1 pb-2">
						<Text role="body" tone="secondary" className="m-0">
							{step.detail ?? KIND_SENTENCE[step.kind]}
						</Text>
						<StepFacts step={step} />
						{step.toolCalls.length > 0 ? (
							<Text role="label" tone="secondary" className="m-0">
								Calls {step.toolCalls.join(", ")}.
							</Text>
						) : null}
						{step.usesModel ? (
							<Text role="label" tone="secondary" className="m-0">
								Asks a model to reason inside this step.
							</Text>
						) : null}
						{step.usesNetwork ? (
							<Text role="label" tone="secondary" className="m-0">
								Makes a network request.
							</Text>
						) : null}
						<StepEvidence
							step={step}
							recorded={recorded}
							run={run}
							loading={loading}
						/>
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</li>
	);
}

/**
 * What a run of this skill does, step by step — read from the saved revision.
 * Read-only: it describes declared structure and recorded evidence, it never
 * executes or approximates a run.
 */
export function SkillAnatomySection({
	skill,
	runs,
}: {
	skill: SkillEntry;
	runs: readonly SkillRunSummary[];
}) {
	const anatomy = useMemo(() => deriveSkillAnatomy(skill), [skill]);
	const evidence = evidenceRun(runs);
	const inspect = useQuery({
		...workflowRunInspectQueryOptions(evidence?.id ?? ""),
		enabled: anatomy.mode === "workflow" && Boolean(evidence),
		retry: false,
	});
	const recorded = useMemo(
		() =>
			inspect.data
				? recordedStepsByName(
						inspect.data.steps.filter((step) => step.kind !== "tool_call"),
					)
				: null,
		[inspect.data],
	);
	const evidenceUnavailable = Boolean(evidence) && inspect.isError;
	return (
		<PageSection aria-labelledby="skill-anatomy-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="skill-anatomy-title">Workflow anatomy</SectionTitle>
					<SectionDescription>
						{anatomy.mode === "workflow"
							? "What a run does, step by step — read from the saved source. Select a step for details."
							: "What this skill asks an assistant to do — read from the saved instructions. Select a step for details."}
					</SectionDescription>
				</SectionHeading>
				<Badge variant="secondary" className="self-start">
					{anatomy.mode === "workflow"
						? "Executable workflow"
						: "Instructions only"}
				</Badge>
			</SectionHeader>
			{anatomy.inputs.length > 0 ? (
				<div className="grid min-w-0 gap-1">
					<Text role="label" tone="secondary" className="m-0">
						Inputs
					</Text>
					<div className="flex flex-wrap gap-2">
						{anatomy.inputs.map((input) => (
							<Badge
								key={input.name}
								variant="outline"
								title={
									input.description ??
									(input.required ? "Required" : "Optional")
								}
							>
								{input.name}
								{input.type ? `: ${input.type}` : ""}
								{input.required ? " · required" : ""}
							</Badge>
						))}
					</div>
				</div>
			) : null}
			{anatomy.steps.length > 0 ? (
				<ol className="m-0 grid min-w-0 list-none gap-0.5 p-0">
					{anatomy.steps.map((step, index) => (
						<AnatomyStepRow
							key={step.id}
							step={step}
							index={index}
							recorded={step.name ? recorded?.get(step.name) : undefined}
							run={evidence}
							loading={inspect.isPending && Boolean(evidence)}
						/>
					))}
				</ol>
			) : (
				<Text role="body" tone="secondary" className="m-0">
					No steps are declared — the run decides its own sequence.
				</Text>
			)}
			<div className="grid min-w-0 gap-1">
				<Text role="label" tone="secondary" className="m-0">
					Output
				</Text>
				<Text role="body" tone="secondary" className="m-0">
					{anatomy.mode === "workflow"
						? "Whatever the run's code returns is kept as the run result."
						: "The assistant reports what it produced; nothing is declared."}{" "}
					{evidence?.hasResult ? (
						<Link href={runHref(evidence.id)}>
							The latest run recorded a result
						</Link>
					) : null}
				</Text>
			</div>
			<ul className="m-0 grid min-w-0 list-none gap-1 p-0">
				{anatomy.notes.map((note) => (
					<li key={note}>
						<Text role="label" tone="secondary" className="m-0">
							{note}
						</Text>
					</li>
				))}
				{evidenceUnavailable ? (
					<li>
						<Text role="label" tone="secondary" className="m-0">
							Run evidence could not be read; the anatomy above is source-only.
						</Text>
					</li>
				) : null}
			</ul>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{evidence ? (
					<Link href={runHref(evidence.id)}>Latest recorded run</Link>
				) : null}
				<Link href={`/skills/${skill.id}/runs`}>
					{runs.length > 0 ? "All recorded runs" : "Runs"}
				</Link>
			</div>
		</PageSection>
	);
}
