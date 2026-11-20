import "./output-views.css";
import "./output-detail.css";
import { SquaresFour } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type {
	OsOutput,
	OsOutputRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenuItem,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
} from "@/components/kumo/dropdown-menu";
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
import { SavedOutputContentView } from "@/components/output-content";
import { OutputExportButtons } from "@/components/output-export-buttons";
import {
	OutputFileMenuButton,
	useOutputFileActions,
} from "@/components/output-file-actions";
import { useOutputsWebMcpTools } from "@/components/outputs-webmcp-tools";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import { ShareControls } from "@/components/share-controls";
import {
	outputDetailQueryOptions,
	workspaceDetailQueryOptions,
} from "@/lib/os-query-options";
import { useOsFormattingPreferences } from "@/lib/format";
import { relativeTime } from "@/lib/time";
import { LoadingArea } from "@/components/loading-area";

export function OutputDetailPage() {
	useOsFormattingPreferences();
	useOutputsWebMcpTools();
	const { outputId } = useParams({
		from: "/_session/_tenant/outputs_/$outputId",
	});
	return <OutputDetail outputId={outputId} key={outputId} />;
}

/**
 * The saved version of an output. Doc, Sheet and Slides are edited only in
 * their workspace gadget, so an output in an active workspace opens there:
 * old `/outputs/<id>` links land in the editor. Outputs outside a workspace
 * stay readable here.
 */
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
	const navigate = useNavigate();
	const openInWorkspace =
		activeWorkspace !== null && detail.data?.output.status === "active";
	useEffect(() => {
		if (!openInWorkspace || !activeWorkspace) return;
		void navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId: activeWorkspace.id },
			search: { workpiece: `output:${outputId}`, pane: "workpiece" },
			replace: true,
		});
	}, [activeWorkspace, navigate, openInWorkspace, outputId]);

	return (
		<Page width="md" className="output-detail-reading">
			<PageBack render={<Link to="/outputs" />}>All documents</PageBack>
			{detail.isPending && <LoadingArea label="Loading document" />}
			{/* The route loader no longer gates on this read (see
			    `prefetchOutputRoute`), so the not-found verdict is owned here: only
			    a settled NOT_FOUND says the output is gone. */}
			{detail.isError && (
				<DetailUnavailable
					resource="Output"
					error={detail.error}
					onRetry={() => detail.refetch()}
					retrying={detail.isFetching}
				/>
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
					<OutputDetailActions
						output={detail.data.output}
						currentRevision={detail.data.currentRevision}
						activeWorkspaceId={activeWorkspace?.id ?? null}
					/>
					<SavedOutputContentView
						outputId={outputId}
						content={detail.data.currentRevision.content}
					/>
				</>
			)}
		</Page>
	);
}

/**
 * Share, open in the workspace, export, and the file's housekeeping (version
 * history, duplicate, move). Phones keep one overflow button for everything
 * but Share, so the housekeeping entries join that menu there.
 */
function OutputDetailActions({
	output,
	currentRevision,
	activeWorkspaceId,
}: {
	output: OsOutput;
	currentRevision: OsOutputRevision;
	activeWorkspaceId: string | null;
}) {
	const navigate = useNavigate();
	const file = useOutputFileActions(
		{
			outputId: output.id,
			title: output.title,
			workspaceId: output.workspaceId,
		},
		{
			onDuplicated: (copy) =>
				void navigate({
					to: "/outputs/$outputId",
					params: { outputId: copy.id },
				}),
		},
	);
	const workspaceLink = activeWorkspaceId ? (
		<Link
			to="/workspace/$workspaceId"
			params={{ workspaceId: activeWorkspaceId }}
			search={{ workpiece: `output:${output.id}`, pane: "workpiece" }}
		/>
	) : null;
	return (
		<PageActions className="output-detail-actions ms-0 w-full justify-start sm:w-auto [&>[data-slot=button]:not([data-icon-only])]:max-sm:flex-1">
			<ShareControls
				outputId={output.id}
				currentRevisionId={currentRevision.id}
			/>
			{workspaceLink ? (
				<Button
					render={workspaceLink}
					variant="outline"
					size="sm"
					className="hidden sm:inline-flex"
				>
					<SquaresFour size={14} /> Open in workspace
				</Button>
			) : null}
			<OutputExportButtons
				outputId={output.id}
				kind={output.kind}
				content={currentRevision.content}
				phoneOverflow
				phoneActions={
					<>
						{workspaceLink ? (
							<DropdownMenuLinkItem
								className="sm:hidden"
								render={workspaceLink}
							>
								<SquaresFour size={14} /> Open in workspace
							</DropdownMenuLinkItem>
						) : null}
						{file.entries.map((entry) => (
							<DropdownMenuItem
								key={entry.key}
								className="sm:hidden"
								onClick={entry.onSelect}
							>
								{entry.icon} {entry.label}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator className="sm:hidden" />
					</>
				}
			/>
			<OutputFileMenuButton
				title={output.title}
				entries={file.entries}
				className="hidden sm:inline-flex"
			/>
			{file.dialogs}
		</PageActions>
	);
}
