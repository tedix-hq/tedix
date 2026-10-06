import {
	ArrowLeft,
	FloppyDisk,
	PencilSimple,
	SquaresFour,
	X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useState } from "react";
import { CostChip } from "@/components/cost-chip";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageMeta,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { OutputContentView } from "@/components/output-content";
import { OutputEditor } from "@/components/output-editor";
import { OutputExportButtons } from "@/components/output-export-buttons";
import { useOutputsWebMcpTools } from "@/components/outputs-webmcp-tools";
import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopFooter,
	OutputWorkshopIdentity,
	outputWorkshopKindLabel,
	OutputWorkshopStage,
	OutputWorkshopStatus,
} from "@/components/output-workshop";
import { ShareControls } from "@/components/share-controls";
import { contentHash, shortHash } from "@/lib/content-hash";
import {
	outputDetailQueryOptions,
	workspaceDetailQueryOptions,
} from "@/lib/os-query-options";
import { normalizeOutputContent } from "@/lib/output-models";
import { useReviseOutput } from "@/lib/use-revise-output";

function IntegrityChip({ content }: { content: OsOutputContent }) {
	const [hash, setHash] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		contentHash(content).then((value) => {
			if (live) setHash(value);
		});
		return () => {
			live = false;
		};
	}, [content]);
	if (!hash) return null;
	return (
		<Badge variant="secondary" title={`sha256 ${hash}`}>
			sha256:{shortHash(hash)}
		</Badge>
	);
}

export function OutputDetailPage() {
	useOutputsWebMcpTools();
	const { outputId } = useParams({
		from: "/_session/_tenant/outputs_/$outputId",
	});
	const detail = useQuery(outputDetailQueryOptions(outputId));
	const workspaceId = detail.data?.output.workspaceId ?? "";
	const workspace = useQuery({
		...workspaceDetailQueryOptions(workspaceId),
		enabled: workspaceId.length > 0,
	});
	const activeWorkspace =
		workspace.data?.workspace.status === "active"
			? workspace.data.workspace
			: null;
	const { save, saving, outcome, clearOutcome } = useReviseOutput(outputId);
	const [draft, setDraft] = useState<OsOutputContent | null>(null);
	const [note, setNote] = useState("");

	const startEditing = () => {
		if (!detail.data) return;
		clearOutcome();
		setNote("");
		setDraft(normalizeOutputContent(detail.data.currentRevision.content));
	};

	const submit = async () => {
		if (!draft || !detail.data) return;
		const result = await save({
			content: draft,
			baseContent: detail.data.currentRevision.content,
			expectedRevision: detail.data.currentRevision.revision,
			note,
		});
		if (result.kind === "saved" || result.kind === "unchanged") {
			setDraft(null);
		}
	};

	const editing = draft !== null;
	const saveFeedback =
		outcome?.kind === "conflict" ? (
			<Alert variant="destructive">
				<AlertTitle>Someone saved a newer revision</AlertTitle>
				<AlertDescription>
					Your draft was NOT written. Reload the output, reapply your change,
					and save again.
				</AlertDescription>
			</Alert>
		) : outcome?.kind === "error" ? (
			<Alert variant="destructive">
				<AlertTitle>Save failed</AlertTitle>
				<AlertDescription>{outcome.message}</AlertDescription>
			</Alert>
		) : outcome?.kind === "unchanged" && detail.data ? (
			<Alert>
				<AlertTitle>No changes to save</AlertTitle>
				<AlertDescription>
					The draft matches revision {detail.data.currentRevision.revision}
					exactly, so no new revision was recorded.
				</AlertDescription>
			</Alert>
		) : null;

	if (editing && detail.data) {
		return (
			<Page
				fullHeight
				width="bleed"
				className="output-detail-workshop"
				data-output-kind={detail.data.output.kind}
			>
				<OutputWorkshopCommandBar>
					<OutputWorkshopIdentity>
						<Button
							render={<Link to="/outputs" />}
							variant="ghost"
							size="icon-sm"
							aria-label="All outputs"
							title="All outputs"
						>
							<ArrowLeft size={14} />
						</Button>
						<h1 title={detail.data.output.title}>{detail.data.output.title}</h1>
						<Badge variant="secondary">
							{outputWorkshopKindLabel(detail.data.output.kind)}
						</Badge>
					</OutputWorkshopIdentity>
					<OutputWorkshopStatus>
						<Badge
							variant="info"
							title={`Editing immutable revision ${detail.data.currentRevision.revision}. Save creates a new revision.`}
						>
							Editing revision {detail.data.currentRevision.revision}
						</Badge>
						<IntegrityChip content={detail.data.currentRevision.content} />
					</OutputWorkshopStatus>
					<OutputWorkshopActions>
						<OutputExportButtons
							outputId={outputId}
							kind={detail.data.output.kind}
							compact
						/>
						<ShareControls
							outputId={outputId}
							currentRevisionId={detail.data.currentRevision.id}
							compact
						/>
					</OutputWorkshopActions>
				</OutputWorkshopCommandBar>
				{saveFeedback ? (
					<div className="output-detail-workshop-feedback">{saveFeedback}</div>
				) : null}
				<OutputWorkshopStage>
					<OutputEditor value={draft} onChange={setDraft} disabled={saving} />
				</OutputWorkshopStage>
				<OutputWorkshopFooter>
					<Input
						aria-label="Revision note"
						value={note}
						onChange={(event) => setNote(event.target.value)}
						placeholder="Revision note (optional)"
						maxLength={2000}
						className="output-detail-revision-note"
					/>
					<Button size="sm" onClick={submit} disabled={saving}>
						<FloppyDisk size={14} /> {saving ? "Saving…" : "Save revision"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={saving}
						onClick={() => {
							setDraft(null);
							clearOutcome();
						}}
					>
						<X size={14} /> Cancel
					</Button>
				</OutputWorkshopFooter>
			</Page>
		);
	}

	return (
		<Page width="md">
			<PageBack render={<Link to="/outputs" />}>All outputs</PageBack>
			{detail.isPending && (
				<div className="grid gap-3" aria-busy="true">
					<Skeleton className="h-8 w-64 rounded-lg" />
					<Skeleton className="h-40 rounded-xl" />
				</div>
			)}
			{/* The route loader no longer gates on this read (see
			    `prefetchOutputRoute`), so the not-found verdict is owned here: only
			    a settled NOT_FOUND says the output is gone. */}
			{detail.isError && (
				<DetailUnavailable resource="Output" error={detail.error} />
			)}
			{detail.data && (
				<>
					<PageHeader>
						<PageHeading>
							<PageTitle>{detail.data.output.title}</PageTitle>
							<PageDescription>
								{outputWorkshopKindLabel(detail.data.output.kind)} · Revision{" "}
								{detail.data.currentRevision.revision}
								{detail.data.currentRevision.note
									? ` — ${detail.data.currentRevision.note}`
									: ""}{" "}
								· by {detail.data.currentRevision.createdByKind}
							</PageDescription>
							<PageMeta>
								{/* Producer lineage exists only when a skill run authored the
								    bytes. A human-authored revision, and every revision written
								    before the column existed, says nothing rather than guessing.
								    The referenced run may have been pruned, so this shows the id
								    it holds without asserting the run still resolves. */}
								{detail.data.authoringHomeRun && (
									<li>
										<Link
											to="/work/executions/$runId"
											search={{ branch: undefined }}
											params={{ runId: detail.data.authoringHomeRun.runId }}
										>
											Authoring Home run
										</Link>
									</li>
								)}
								{detail.data.currentRevision.producedBy && (
									<li>
										Produced by{" "}
										{detail.data.currentRevision.producedBy.skillId ??
											"a skill run"}{" "}
										· run{" "}
										{detail.data.currentRevision.producedBy.skillRunId.slice(
											0,
											8,
										)}
									</li>
								)}
								<li className="flex items-center">
									<IntegrityChip
										content={detail.data.currentRevision.content}
									/>
								</li>
								{detail.data.authoringHomeRun ? (
									<li>No per-output cost allocation; see the authoring run.</li>
								) : (
									<li className="flex items-center">
										<CostChip
											reading={{
												kind: "absent",
												reason: "no_attribution_path",
											}}
											subject="Cost attribution for this output"
										/>
									</li>
								)}
							</PageMeta>
						</PageHeading>
						<PageActions>
							{activeWorkspace ? (
								<Button
									render={
										<Link
											to="/workspace/$workspaceId"
											params={{ workspaceId: activeWorkspace.id }}
											search={{
												workpiece: `output:${outputId}`,
												pane: "workpiece",
											}}
										/>
									}
									variant="secondary"
								>
									<SquaresFour size={14} /> Open in workspace
								</Button>
							) : null}
							{detail.data.output.status === "active" && (
								<Button variant="secondary" onClick={startEditing}>
									<PencilSimple size={14} /> Edit
								</Button>
							)}
							<OutputExportButtons
								outputId={outputId}
								kind={detail.data.output.kind}
							/>
							<ShareControls
								outputId={outputId}
								currentRevisionId={detail.data.currentRevision.id}
							/>
						</PageActions>
					</PageHeader>
					{saveFeedback}
					<OutputContentView content={detail.data.currentRevision.content} />
				</>
			)}
		</Page>
	);
}
