import type {
	OsCollaborationDocumentType,
	OsCollaborationProposal,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import {
	type DiffHunk,
	type DiffLine,
	buildUnifiedDiff,
	collapseDiff,
} from "@/lib/diff/diff-model";
import { lineSegments } from "@/lib/diff/diff-segments";
import {
	canvasGadgetDetailQueryOptions,
	collaborationProposalsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { cn } from "@/lib/utils";

const PROPOSAL_LIST_LIMIT = 20;

/** Diff rows rendered before the reviewer asks for the rest. */
const COLLAPSED_DIFF_LINES = 120;

export type CanvasProposalsProps = {
	workspaceId: string;
	documentType: OsCollaborationDocumentType;
	documentId: string;
	mergeBlockedReason?: string;
	showHeading?: boolean;
	onMerged: (revision: number, revisionId: string) => void;
};

/**
 * The raw-payload escape hatch. It is deliberately the SECONDARY view: reviewing
 * an agent-authored change by eyeballing a truncated JSON blob is what the diff
 * above replaces. It stays reachable because a diff cannot show a payload the
 * base revision failed to load, and because "what exactly is being merged" is a
 * legitimate question.
 */
function previewText(proposal: OsCollaborationProposal): string {
	const text = canonicalJsonText(proposal.content);
	return text.length <= 5_000 ? text : `${text.slice(0, 5_000)}\n…`;
}

/** Row tone per line kind. Each carries a change bar as well as a fill, so the
 * three kinds stay apart at the low-contrast end and in a monochrome rendering;
 * the sign column below is the redundant, non-colour cue. */
const DIFF_ROW_TONE: Record<DiffLine["kind"], string> = {
	added: "border-kumo-success border-l-2 bg-kumo-success-tint",
	removed: "border-kumo-danger border-l-2 bg-kumo-danger-tint",
	context: "border-l-2 border-transparent",
};

const DIFF_ROW_SIGN: Record<DiffLine["kind"], string> = {
	added: "+",
	removed: "−",
	context: " ",
};

/** Inline word highlight: an intensified fill plus a shape cue. */
const DIFF_MARK_TONE: Record<DiffLine["kind"], string> = {
	added: "bg-kumo-success/25 underline decoration-2 underline-offset-2",
	removed: "bg-kumo-danger/25 line-through",
	context: "",
};

function DiffRow({ line }: { line: DiffLine }) {
	const segments = lineSegments(line.text, line.slices);
	return (
		<div
			className={cn(
				"flex gap-2 whitespace-pre px-2 py-px",
				DIFF_ROW_TONE[line.kind],
			)}
		>
			<span
				aria-hidden
				className="w-8 shrink-0 select-none text-right text-kumo-subtle"
			>
				{line.originalLine ?? ""}
			</span>
			<span
				aria-hidden
				className="w-8 shrink-0 select-none text-right text-kumo-subtle"
			>
				{line.modifiedLine ?? ""}
			</span>
			<span className="w-3 shrink-0 select-none">
				{DIFF_ROW_SIGN[line.kind]}
			</span>
			{/* Segments are a positional decomposition of one line and carry no
			    other identity, so the index is the key. */}
			<span className="min-w-0 break-all">
				{segments.map((segment, index) =>
					segment.changed ? (
						<mark
							key={index}
							className={cn(
								"bg-transparent text-inherit",
								DIFF_MARK_TONE[line.kind],
							)}
						>
							{segment.text}
						</mark>
					) : (
						<span key={index}>{segment.text}</span>
					),
				)}
			</span>
		</div>
	);
}

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
	return (
		<div>
			<div className="bg-kumo-tint px-2 py-px text-kumo-subtle">
				{`From line ${hunk.originalStart} in the saved version · line ${hunk.modifiedStart} in the suggestion`}
			</div>
			{hunk.lines.map((line, index) => (
				<DiffRow key={`${hunk.key}-${index}`} line={line} />
			))}
		</div>
	);
}

type ProposalDiffProps = {
	/** Canonical text of the revision the proposal is pinned to. */
	baseText: string;
	/** Canonical text of the proposal's preview payload. */
	previewTextValue: string;
	/** True when the canonical document has moved past the proposal's base. */
	baseMoved: boolean;
};

/**
 * The review affordance: what this proposal would change about the canonical
 * document, not what the proposal contains. Both sides are canonicalised JSON
 * (see `canonicalJsonText`), so a reordered object is not reported as an edit.
 */
function ProposalDiff({
	baseText,
	previewTextValue,
	baseMoved,
}: ProposalDiffProps) {
	const [expanded, setExpanded] = useState(false);
	const model = useMemo(
		() => buildUnifiedDiff(baseText, previewTextValue),
		[baseText, previewTextValue],
	);
	const collapsed = collapseDiff(
		model,
		expanded ? Number.POSITIVE_INFINITY : COLLAPSED_DIFF_LINES,
	);

	if (model.status === "unchanged") {
		return (
			<Text
				as="p"
				role="label"
				tone="secondary"
				className="m-0 rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2"
			>
				This suggestion matches the saved version. Applying it would not change
				the content.
			</Text>
		);
	}

	return (
		<div className="grid gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="success">{`${model.additions} ${model.additions === 1 ? "line" : "lines"} added`}</Badge>
				<Badge variant="error">{`${model.deletions} ${model.deletions === 1 ? "line" : "lines"} removed`}</Badge>
				{model.approximate && (
					<Text as="span" role="label" tone="warning">
						This change is large, so the comparison may be approximate.
					</Text>
				)}
			</div>
			{baseMoved && (
				<Text as="p" role="label" tone="warning" className="m-0">
					The saved version has changed since this suggestion was made. The
					comparison shows the latest version. Ask for an updated suggestion
					before applying it.
				</Text>
			)}
			<details className="type-tedix-control">
				<summary className="cursor-pointer py-1 text-kumo-link">
					Compare changes
				</summary>
				<div
					aria-label="Proposed change"
					className="max-h-80 overflow-auto rounded-lg border border-kumo-line bg-kumo-base font-mono text-xs leading-5"
				>
					{collapsed.hunks.map((hunk) => (
						<DiffHunkBlock hunk={hunk} key={hunk.key} />
					))}
				</div>
				{collapsed.hiddenLines > 0 && (
					<Button onClick={() => setExpanded(true)} size="sm" variant="ghost">
						{`Show ${collapsed.hiddenLines} more lines`}
					</Button>
				)}
			</details>
		</div>
	);
}

export function CanvasProposals({
	workspaceId,
	documentType,
	documentId,
	mergeBlockedReason,
	showHeading = true,
	onMerged,
}: CanvasProposalsProps) {
	const queryClient = useQueryClient();
	const [rationales, setRationales] = useState<Record<string, string>>({});
	const proposalsInput = {
		workspaceId,
		documentType,
		documentId,
		limit: PROPOSAL_LIST_LIMIT,
	};
	const proposals = useQuery({
		...collaborationProposalsQueryOptions(proposalsInput),
		refetchInterval: (query) =>
			query.state.data?.items.some(
				(proposal) =>
					proposal.status === "open" || proposal.status === "accepted",
			)
				? 1_000
				: false,
	});

	// The diff's left-hand side. Both callers already load this document, so
	// these resolve from the same contract-derived cache entry rather than
	// costing a second request.
	const isGadget = documentType === "gadget";
	const gadget = useQuery({
		...canvasGadgetDetailQueryOptions(workspaceId, documentId),
		enabled: isGadget,
	});
	const output = useQuery({
		...outputDetailQueryOptions(documentId),
		enabled: !isGadget,
	});
	const canonicalRevision = isGadget
		? gadget.data?.currentRevision
		: output.data?.currentRevision;
	const baseText = useMemo(() => {
		if (!canonicalRevision) return null;
		return canonicalJsonText(
			"manifest" in canonicalRevision
				? canonicalRevision.manifest
				: canonicalRevision.content,
		);
	}, [canonicalRevision]);

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: collaborationProposalsQueryOptions(proposalsInput).queryKey,
		});

	const decide = useMutation({
		mutationFn: async ({
			proposal,
			decision,
		}: {
			proposal: OsCollaborationProposal;
			decision: "accept" | "reject";
		}) => {
			const rationale = rationales[proposal.id]?.trim();
			if (!rationale) throw new Error("Add a reason for your decision first");
			const input = {
				proposalId: proposal.id,
				expectedSequence: proposal.sequence,
				rationale,
				evidenceRefs: [],
			};
			return decision === "accept"
				? osApi.osWorkspaces.collaboration.accept(input)
				: osApi.osWorkspaces.collaboration.reject(input);
		},
		onSuccess: refresh,
	});

	const merge = useMutation({
		mutationFn: (proposal: OsCollaborationProposal) => {
			if (mergeBlockedReason) throw new Error(mergeBlockedReason);
			const rationale = rationales[proposal.id]?.trim();
			if (!rationale)
				throw new Error("Add a reason for applying this change first");
			return osApi.osWorkspaces.collaboration.merge({
				proposalId: proposal.id,
				expectedSequence: proposal.sequence,
				rationale,
				evidenceRefs: [],
			});
		},
		onSuccess: ({ revision }) => {
			onMerged(revision.revision, revision.id);
			void refresh();
		},
	});

	if (proposals.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Could not load suggested changes</AlertTitle>
				<AlertDescription>
					{(proposals.error as Error).message}
				</AlertDescription>
			</Alert>
		);
	}
	if (!proposals.data || proposals.data.items.length === 0) {
		if (showHeading) return null;
		return (
			<Text as="p" role="body" tone="secondary" className="m-0">
				{proposals.isPending
					? "Loading suggested changes…"
					: "No suggested changes to review."}
			</Text>
		);
	}

	return (
		<section className="grid gap-2" aria-label="Suggested changes">
			{showHeading && (
				<Text as="h3" role="body" weight="semibold" className="m-0">
					Suggested changes
				</Text>
			)}
			{mergeBlockedReason && (
				<Text as="p" role="label" tone="warning">
					{mergeBlockedReason}
				</Text>
			)}
			{proposals.data.items.map((proposal, index) => (
				<Card key={proposal.id}>
					<CardHeader className="flex-row items-center justify-between gap-2">
						<CardTitle>Suggested change {index + 1}</CardTitle>
						<Badge
							variant={proposal.status === "merged" ? "success" : "secondary"}
						>
							{
								{
									open: "Needs review",
									accepted: "Approved · not applied",
									merged: "Applied",
									rejected: "Rejected",
								}[proposal.status]
							}
						</Badge>
					</CardHeader>
					<CardContent className="grid gap-2">
						<Text as="p" role="label" tone="secondary" className="m-0">
							Based on version {proposal.baseRevision}
							{proposal.resultRevision !== null &&
								` · applied as version ${proposal.resultRevision}`}
						</Text>
						<details className="text-kumo-subtle type-tedix-control">
							<summary className="cursor-pointer">Technical details</summary>
							<dl className="mt-2 grid gap-1 break-all">
								<dt>Source</dt>
								<dd className="m-0">
									{proposal.sourceKind} · {proposal.sourceId}
								</dd>
								<dt>Suggestion ID</dt>
								<dd className="m-0">{proposal.id}</dd>
								<dt>Preview number</dt>
								<dd className="m-0">{proposal.sequence}</dd>
							</dl>
						</details>
						{baseText === null ? (
							/*
							 * No canonical base to diff against: a Gadget with no recorded
							 * revision, or a document read that has not resolved yet. The
							 * raw payload is all there is to show, still clamped and
							 * truncated — the copy button is how an operator gets it out.
							 */
							<details className="type-tedix-control">
								<summary className="cursor-pointer">
									View suggested content
								</summary>
								<CodeBlock
									className="max-h-56 overflow-auto"
									code={previewText(proposal)}
									lang="json"
									showCopyButton
								/>
							</details>
						) : (
							<ProposalDiff
								baseMoved={
									canonicalRevision != null &&
									canonicalRevision.id !== proposal.baseRevisionId
								}
								baseText={baseText}
								previewTextValue={canonicalJsonText(proposal.content)}
							/>
						)}
						{(proposal.status === "open" || proposal.status === "accepted") && (
							<>
								<Input
									aria-label={`Reason for change ${index + 1}`}
									placeholder="Reason for your decision"
									value={rationales[proposal.id] ?? ""}
									onChange={(event) =>
										setRationales((current) => ({
											...current,
											[proposal.id]: event.target.value,
										}))
									}
									maxLength={4000}
								/>
								<Text as="p" role="label" tone="secondary" className="m-0">
									Add a reason. It will be saved with your decision. Approval
									does not apply the change.
								</Text>
								<div className="flex flex-wrap gap-2">
									{proposal.status === "open" && (
										<Button
											size="sm"
											disabled={
												decide.isPending || !rationales[proposal.id]?.trim()
											}
											onClick={() =>
												decide.mutate({ proposal, decision: "accept" })
											}
										>
											Approve change
										</Button>
									)}
									<Button
										variant="ghost"
										size="sm"
										disabled={
											decide.isPending || !rationales[proposal.id]?.trim()
										}
										onClick={() =>
											decide.mutate({ proposal, decision: "reject" })
										}
									>
										Reject
									</Button>
									{proposal.status === "accepted" && (
										<Button
											size="sm"
											disabled={
												merge.isPending ||
												!!mergeBlockedReason ||
												!rationales[proposal.id]?.trim()
											}
											onClick={() => merge.mutate(proposal)}
										>
											Apply change
										</Button>
									)}
								</div>
							</>
						)}
					</CardContent>
				</Card>
			))}
			{(decide.isError || merge.isError) && (
				<Alert variant="destructive">
					<AlertTitle>Could not complete your decision</AlertTitle>
					<AlertDescription>
						{((decide.error ?? merge.error) as Error).message}
					</AlertDescription>
				</Alert>
			)}
		</section>
	);
}
