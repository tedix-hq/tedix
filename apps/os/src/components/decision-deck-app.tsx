import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DecisionKindSchema,
	decisionNeedsPerson,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionEnvelopeCard } from "@/components/decision-envelope-card";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { ApprovalDecisionCard } from "@/components/work-decision-stack";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	classReadiness,
	decisionEnvelope,
	decisionFeedbackMetadata,
	type DecisionLearningReceipt,
} from "@/lib/decision-deck";
import { decisionCaptureSummary } from "@/lib/work-interaction-display";
import { buildDecisionDeckWebMcpTools } from "@/components/decision-deck-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import { isOpenRequestForYou } from "@/components/work-needs-you-count";

const KIND_LABELS: Record<string, string> = {
	all: "All kinds",
	outbound: "Messages",
	proposal: "Proposals",
	question: "Questions",
	approval: "Approvals",
	decision: "Choices",
	adr: "Architecture",
};

export function DecisionDeckApp({ config }: { config: DecisionDeckConfig }) {
	const client = useQueryClient();
	const [mode, setMode] = useState("decide");
	const [kind, setKind] = useState("all");
	const [project, setProject] = useState("all");
	const [urgency, setUrgency] = useState("all");
	const [search, setSearch] = useState("");
	const [index, setIndex] = useState(0);
	const [practice, setPractice] = useState<DecisionLearningReceipt[]>([]);
	const [skipped, setSkipped] = useState<string[]>([]);
	const inbox = useQuery(
		osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config.projectId,
				limit: config.limit,
				states: ["open"],
			},
		}),
	);
	const history = useQuery(
		osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config.projectId,
				limit: config.limit,
				states: ["resolved"],
			},
		}),
	);
	const approvals = useQuery({
		...pendingApprovalsQueryOptions(),
		enabled: !config.projectId,
	});
	const profile = useQuery(userProfileQueryOptions());
	const projects = useQuery(projectListQueryOptions(100));
	const projectNames = new Map(
		(projects.data?.data ?? []).map((row) => [row.id, row.name]),
	);
	const projectLabel = (id: string) =>
		projectNames.get(id) ??
		(["Examples", "Unfiled", "Organization"].includes(id)
			? id
			: "Project unavailable");
	const historical = (history.data?.data ?? []).filter(
		(row) =>
			row.effectiveState === "resolved" &&
			decisionEnvelope(row.request.metadata),
	);
	const details = useQueries({
		queries: historical.map((row) =>
			workInteractionDetailQueryOptions(row.request.id),
		),
	});
	const receipts: DecisionLearningReceipt[] = details.flatMap((detail) =>
		(detail.data?.responses.data ?? []).flatMap((response) => {
			const meta = response.metadata;
			return response.respondedByType === "user" &&
				response.respondedById === profile.data?.id &&
				typeof meta?.decisionClass === "string"
				? [
						{
							id: response.id,
							classId: meta.decisionClass,
							choice: String(meta.decisionChoice ?? "unknown"),
							signal: String(meta.feedbackSignal ?? "unknown"),
							at: response.respondedAt,
							feedback:
								typeof meta.feedbackText === "string"
									? meta.feedbackText
									: undefined,
						},
					]
				: [];
		}),
	);
	const today = new Date().toISOString().slice(0, 10);
	const todayCount = receipts.filter((row) => row.at.startsWith(today)).length;
	const practiceMode = mode === "practice";
	const rows = practiceMode
		? config.examples.map((decision, i) => ({
				id: `example:${i}`,
				kind: decision.kind,
				label: decision.proposal,
				project: "Examples",
				urgency: "later",
				decision,
				row: undefined,
			}))
		: [
				...((mode === "history" ? history : inbox).data?.data ?? [])
					.filter((row) =>
						mode === "history"
							? row.effectiveState === "resolved"
							: isOpenRequestForYou(row) && row.canRespond,
					)
					.map((row) => {
						const decision = decisionEnvelope(row.request.metadata);
						const metadata = row.request.metadata;
						const cardKind =
							decision?.kind ??
							(metadata?.schema === "tedix.outbound.v1"
								? "outbound"
								: row.request.kind === "handoff"
									? "proposal"
									: metadata?.decisionCard
										? "decision"
										: "question");
						return {
							id: row.request.id,
							kind: cardKind,
							label: row.request.subject,
							project:
								row.workItem?.projectId ?? row.request.projectId ?? "Unfiled",
							urgency: decisionCaptureSummary(metadata)?.urgency ?? "later",
							decision,
							row,
						};
					}),
				...(!config.projectId && mode === "decide"
					? (approvals.data?.data ?? []).map((approval) => ({
							id: `approval:${approval.id}`,
							kind: "approval",
							label: approval.description,
							project: "Organization",
							urgency: "now",
							decision: null,
							row: undefined,
						}))
					: []),
			];
	const filtered = rows
		.sort((a, b) => Number(b.urgency === "now") - Number(a.urgency === "now"))
		.filter(
			(row) =>
				(mode === "history" ||
					!row.decision ||
					decisionNeedsPerson(row.decision)) &&
				(kind === "all" || row.kind === kind) &&
				(project === "all" || row.project === project) &&
				(urgency === "all" || row.urgency === urgency) &&
				row.label.toLowerCase().includes(search.toLowerCase()) &&
				(mode === "history" || !skipped.includes(row.id)),
		);
	const selected = filtered[index % Math.max(1, filtered.length)];
	const current = selected?.decision;
	const classId = current?.classId ?? selected?.kind;
	const learning = classId
		? classReadiness(
				practiceMode ? practice : receipts,
				classId,
				config.unchangedThreshold,
			)
		: null;
	const next = () => setIndex((value) => value + 1);
	const previous = () => setIndex((value) => Math.max(0, value - 1));
	const budgetReached =
		mode === "decide" &&
		todayCount >= config.dailyAttentionBudget &&
		selected?.urgency !== "now";
	useAppWebMcpTools(
		"decision_deck",
		{
			mode,
			card: selected
				? {
						id: selected.id,
						kind: selected.kind,
						label: selected.label,
						decision: current ?? null,
					}
				: null,
			readiness: learning,
			remaining: filtered.length,
		},
		buildDecisionDeckWebMcpTools,
		[],
	);
	return (
		<div
			className="mx-auto grid w-full min-w-0 max-w-2xl gap-4 pb-8"
			data-workspace-app-entry="decision-deck"
		>
			<div className="grid gap-2">
				<Text as="h2" weight="semibold">
					One decision at a time
				</Text>
				<Text>
					Teach your OS what matters. Reversible work keeps moving and leaves
					receipts.
				</Text>
				<Text tone="secondary">
					{todayCount}/{config.dailyAttentionBudget} loaded learning receipts
					today (UTC) · ←/→ choose · J/K browse · swipe left/right
				</Text>
			</div>
			<div className="flex flex-wrap gap-2" aria-label="Deck view">
				{[
					"decide",
					"history",
					...(config.examples.length ? ["practice"] : []),
				].map((value) => (
					<Button
						key={value}
						variant={mode === value ? "default" : "outline"}
						onClick={() => {
							setMode(value);
							setIndex(0);
							setSkipped([]);
						}}
					>
						{value === "decide"
							? "For you"
							: value === "history"
								? "What you decided"
								: "Try examples"}
					</Button>
				))}
			</div>
			<div className="flex flex-wrap gap-2">
				<Select
					value={kind}
					onValueChange={(value) => {
						setKind(value ?? "all");
						setIndex(0);
					}}
				>
					<SelectTrigger aria-label="Decision kind">
						<SelectValue>{KIND_LABELS[kind]}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All kinds</SelectItem>
						{DecisionKindSchema.options.map((value) => (
							<SelectItem key={value} value={value}>
								{KIND_LABELS[value]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={project}
					onValueChange={(value) => {
						setProject(value ?? "all");
						setIndex(0);
					}}
				>
					<SelectTrigger aria-label="Decision project">
						<SelectValue>
							{project === "all" ? "All projects" : projectLabel(project)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All projects</SelectItem>
						{[...new Set(rows.map((row) => row.project))].map((value) => (
							<SelectItem key={value} value={value}>
								{projectLabel(value)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={urgency}
					onValueChange={(value) => {
						setUrgency(value ?? "all");
						setIndex(0);
					}}
				>
					<SelectTrigger aria-label="Decision urgency">
						<SelectValue>
							{urgency === "all"
								? "Any urgency"
								: urgency === "now"
									? "Needs you now"
									: "Can wait"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Any urgency</SelectItem>
						<SelectItem value="now">Needs you now</SelectItem>
						<SelectItem value="later">Can wait</SelectItem>
					</SelectContent>
				</Select>
				<Input
					aria-label="Find decisions"
					placeholder="Find a decision"
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						setIndex(0);
					}}
				/>
			</div>
			{practiceMode && (
				<Text role="label">
					Practice only. Choices below stay in this preview and never approve
					Work, send messages or teach your real profile.
				</Text>
			)}
			{!practiceMode && (inbox.isError || approvals.isError) && (
				<Text role="body">
					Some decisions could not be loaded.{" "}
					<Button
						variant="outline"
						onClick={() => {
							void inbox.refetch();
							void approvals.refetch();
						}}
					>
						Try again
					</Button>
				</Text>
			)}
			{!practiceMode && inbox.isPending && <Text>Loading decisions…</Text>}
			{learning && classId && (
				<div
					className="rounded-xl border border-kumo-line p-3"
					aria-label="Class readiness"
				>
					<Text weight="medium">
						{classId}: {learning.unchanged}/{config.unchangedThreshold}{" "}
						unchanged approvals
					</Text>
					<Text tone="secondary">
						{learning.ready
							? "Ready for a delegation review"
							: "Learning your preferences"}{" "}
						· {learning.delegated}/{learning.total} delegated ·{" "}
						{Math.round(config.auditSampleRate * 100)}% proposed audits
					</Text>
					<Text role="label">
						Recent loaded history only. Readiness does not grant permission or
						turn on automation.
					</Text>
				</div>
			)}
			{budgetReached ? (
				<Text>
					You’ve reached your attention budget. Urgent choices still appear with
					“Needs you now”. <Link href="/work/attention">Open Needs you</Link>
				</Text>
			) : selected ? (
				<div key={`${mode}:${selected.id}`} className="grid gap-3">
					<Text role="label">
						{selected.kind === "adr" ? "Architecture decision" : selected.kind}{" "}
						· {(index % filtered.length) + 1} of {filtered.length}
					</Text>
					{mode === "history" ? (
						<WorkDecisionCard
							kind={current?.kind ?? "decision"}
							title={selected.label}
							askedBy={selected.row?.askedBy ?? "Your tedi"}
							body={selected.row?.request.prompt}
							why={
								<Link href={`/work/interactions/${selected.id}`}>
									Read the saved answer and history
								</Link>
							}
							disabled
							onDecision={async () => {}}
							onNext={next}
							onPrevious={previous}
						/>
					) : selected.id.startsWith("approval:") ? (
						<ApprovalDecisionCard
							id={selected.id.slice("approval:".length)}
							onNext={next}
							onPrevious={previous}
						/>
					) : current &&
					  (practiceMode ||
							current.kind === "adr" ||
							current.kind === "decision") ? (
						<DecisionEnvelopeCard
							decision={current}
							defaultLowStakesToDelegate={config.defaultLowStakesToDelegate}
							askedBy={
								practiceMode
									? "Example"
									: (selected.row?.askedBy ?? "Your tedi")
							}
							disabled={mode === "history"}
							onNext={next}
							onPrevious={previous}
							onDecision={async (feedback, choice, elapsedMs) => {
								if (practiceMode) {
									setPractice((value) => [
										...value,
										{
											id: crypto.randomUUID(),
											classId: current.classId,
											choice,
											signal: feedback.signal,
											at: new Date().toISOString(),
											elapsedMs,
										},
									]);
									return;
								}
								const request = selected.row!.request;
								await osApi.workInteractions.respond({
									requestId: request.id,
									expectedRequestVersion: request.version,
									responseKind: "answer",
									body:
										choice === "change"
											? feedback.body
											: `${current.options.find((option) => option.id === feedback.action)!.label}: ${current.options.find((option) => option.id === feedback.action)!.consequence}${feedback.feedback ? ` Feedback: ${feedback.feedback}` : ""}`,
									resolvesRequest: choice !== "later",
									metadata: decisionFeedbackMetadata(
										feedback,
										current.classId,
										choice,
										elapsedMs,
									),
								});
								if (choice === "later")
									setSkipped((value) => [...value, selected.id]);
								await client.invalidateQueries({
									queryKey: osQuery.workInteractions.key({ type: "query" }),
								});
							}}
						/>
					) : (
						<WorkInteractionDecisionCard
							requestId={selected.id}
							askedBy={selected.row?.askedBy}
							autoFocus
							onNext={next}
							onPrevious={previous}
						/>
					)}
					<div className="flex justify-between gap-2">
						<Button variant="outline" onClick={previous}>
							Previous
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								setSkipped((value) => [...value, selected.id]);
							}}
						>
							Later in this visit
						</Button>
						<Button variant="outline" onClick={next}>
							Next
						</Button>
					</div>
				</div>
			) : (
				!inbox.isPending && (
					<Text>
						No decisions match. Your OS can keep doing reversible work.
					</Text>
				)
			)}
			{practiceMode && practice.length > 0 && (
				<Text>{practice.length} practice choices in this preview.</Text>
			)}
			{!practiceMode &&
				(inbox.data?.hasMore ||
					history.data?.hasMore ||
					details.some((detail) => detail.data?.responses.hasMore)) && (
					<Link href="/work/attention">More history and decisions in Work</Link>
				)}
			<Link href="/account/profile">
				Your style profile and last 10 approvals
			</Link>
		</div>
	);
}
