import "./output-editor.css";
import "./output-detail.css";
import {
	ArrowLeft,
	FloppyDisk,
	PencilSimple,
	SquaresFour,
	X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { DropdownMenuLinkItem } from "@/components/kumo/dropdown-menu";
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
import {
	outputDetailQueryOptions,
	workspaceDetailQueryOptions,
} from "@/lib/os-query-options";
import { normalizeOutputContent } from "@/lib/output-models";
import { useOsFormattingPreferences } from "@/lib/format";
import { relativeTime } from "@/lib/time";
import { useReviseOutput } from "@/lib/use-revise-output";

export function OutputDetailPage() {
	useOsFormattingPreferences();
	useOutputsWebMcpTools();
	const { outputId } = useParams({
		from: "/_session/_tenant/outputs_/$outputId",
	});
	return <OutputDetail outputId={outputId} key={outputId} />;
}

function OutputDetail({ outputId }: { outputId: string }) {
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
	const navigate = useNavigate();
	const [draft, setDraft] = useState<OsOutputContent | null>(null);
	const [draftBaseline, setDraftBaseline] = useState("");
	const [note, setNote] = useState("");
	const [confirmLeave, setConfirmLeave] = useState(false);

	const startEditing = () => {
		if (!detail.data) return;
		clearOutcome();
		setNote("");
		const content = normalizeOutputContent(detail.data.currentRevision.content);
		setDraftBaseline(JSON.stringify(content));
		setDraft(content);
	};
	const dirty =
		draft !== null &&
		(note.trim() !== "" || JSON.stringify(draft) !== draftBaseline);

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
				<AlertTitle>Someone else saved a newer version</AlertTitle>
				<AlertDescription>
					Your changes were not saved. Reload the page, make your change again,
					and save.
				</AlertDescription>
			</Alert>
		) : outcome?.kind === "error" ? (
			<Alert variant="destructive">
				<AlertTitle>Couldn't save</AlertTitle>
				<AlertDescription>{outcome.message}</AlertDescription>
			</Alert>
		) : outcome?.kind === "unchanged" && detail.data ? (
			<Alert>
				<AlertTitle>No changes to save</AlertTitle>
				<AlertDescription>
					Nothing changed since version {detail.data.currentRevision.revision},
					so nothing new was saved.
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
							onClick={(event) => {
								// Leaving the workshop drops the draft; ask first.
								if (!dirty) return;
								event.preventDefault();
								setConfirmLeave(true);
							}}
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
							title="Saving keeps the earlier version and adds a new one."
						>
							Editing version {detail.data.currentRevision.revision}
						</Badge>
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
						aria-label="What changed"
						value={note}
						onChange={(event) => setNote(event.target.value)}
						placeholder="What changed? (optional)"
						maxLength={2000}
						className="output-detail-revision-note"
					/>
					<Button size="sm" onClick={submit} disabled={saving}>
						<FloppyDisk size={14} /> {saving ? "Saving…" : "Save"}
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
				<ConfirmDialog
					open={confirmLeave}
					onOpenChange={setConfirmLeave}
					title="Discard your changes?"
					description="Your edits to this output are not saved. Leaving now discards them."
					confirmLabel="Discard changes"
					pendingLabel="Discarding…"
					cancelLabel="Keep editing"
					destructive
					isPending={false}
					onConfirm={() => {
						setConfirmLeave(false);
						setDraft(null);
						clearOutcome();
						void navigate({ to: "/outputs" });
					}}
				/>
			</Page>
		);
	}

	return (
		<Page width="md" className="output-detail-reading">
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
							<PageTitle className="[overflow-wrap:anywhere]">
								{detail.data.output.title}
							</PageTitle>
							<PageDescription>
								{outputWorkshopKindLabel(detail.data.output.kind)} · Version{" "}
								{detail.data.currentRevision.revision} · updated{" "}
								{relativeTime(detail.data.currentRevision.createdAt)}
								{detail.data.currentRevision.note
									? ` · ${detail.data.currentRevision.note}`
									: ""}
							</PageDescription>
							{detail.data.authoringHomeRun ||
							detail.data.currentRevision.producedBy ? (
								<PageMeta>
									{/* Producer lineage exists only when a skill run authored the
									    bytes. A human-authored revision, and every revision written
									    before the column existed, says nothing rather than guessing.
									    The referenced run may have been pruned, so the link is not
									    an assertion that it still resolves. */}
									{detail.data.currentRevision.producedBy && (
										<li>
											Made by{" "}
											{detail.data.currentRevision.producedBy.skillId ??
												"a skill"}
										</li>
									)}
									{detail.data.authoringHomeRun && (
										<li>
											<Link
												to="/work/executions/$runId"
												search={{ branch: undefined }}
												params={{ runId: detail.data.authoringHomeRun.runId }}
											>
												See how it was made
											</Link>
										</li>
									)}
								</PageMeta>
							) : null}
						</PageHeading>
					</PageHeader>
					<PageActions className="output-detail-actions ms-0 w-full justify-start sm:w-auto [&>[data-slot=button]:not([data-icon-only])]:max-sm:flex-1">
						{detail.data.output.status === "active" && (
							<Button size="sm" onClick={startEditing}>
								<PencilSimple size={14} /> Edit
							</Button>
						)}
						<ShareControls
							outputId={outputId}
							currentRevisionId={detail.data.currentRevision.id}
						/>
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
								variant="outline"
								size="sm"
								className="hidden sm:inline-flex"
							>
								<SquaresFour size={14} /> Open in workspace
							</Button>
						) : null}
						<OutputExportButtons
							outputId={outputId}
							kind={detail.data.output.kind}
							phoneOverflow
							phoneActions={
								activeWorkspace ? (
									<DropdownMenuLinkItem
										className="sm:hidden"
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
									>
										<SquaresFour size={14} /> Open in workspace
									</DropdownMenuLinkItem>
								) : null
							}
						/>
					</PageActions>
					{saveFeedback}
					<OutputContentView
						content={detail.data.currentRevision.content}
						onEdit={
							detail.data.output.status === "active" ? startEditing : undefined
						}
					/>
				</>
			)}
		</Page>
	);
}
