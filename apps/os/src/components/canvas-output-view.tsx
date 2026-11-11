import "./output-views.css";
import { ArrowsIn } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import { CanvasOutputTitle } from "@/components/canvas-output-title";
import { CanvasProposals } from "@/components/canvas-proposals";
import { OutputExportButtons } from "@/components/output-export-buttons";
import { ShareButton } from "@/components/share-controls";
import { OutputContentView } from "@/components/output-content";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import {
	outputDetailQueryOptions,
	osQuery,
	osQueryKeys,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

/**
 * An output opened in a Workspace without an editor app. Doc, Sheet and
 * Slides are edited only in their workspace gadget, so this view reads the
 * saved version and offers to attach the editor. Attaching is idempotent: an
 * output that already has an editor returns that same app.
 */
export function CanvasOutputView({
	workspaceId,
	outputId,
	onOpenEditor,
	focusMode = false,
	onFocusModeChange,
	onShare,
}: {
	workspaceId: string;
	outputId: string;
	onOpenEditor: (gadgetId: string) => void;
	focusMode?: boolean;
	/** Focus mode hides the top bar, so leaving it lives here. */
	onFocusModeChange?: (focused: boolean) => void;
	onShare?: () => void;
}) {
	const queryClient = useQueryClient();
	const detail = useQuery(outputDetailQueryOptions(outputId));
	const install = useMutation(
		osQuery.osWorkspaces.gadgets.installOutputEditor.mutationOptions(),
	);
	if (detail.isError)
		return (
			<Alert variant="warning">
				<AlertTitle>This output did not load</AlertTitle>
				<AlertDescription>
					Check your access to this workspace, then try again.
				</AlertDescription>
				<Button size="sm" variant="secondary" onClick={() => detail.refetch()}>
					Try again
				</Button>
			</Alert>
		);
	if (!detail.data) return <ListSkeleton rows={1} rowClassName="h-64" />;
	const { output, currentRevision } = detail.data;
	const editable =
		output.status === "active" &&
		output.kind !== "video" &&
		!(
			currentRevision.content.kind === "document" &&
			currentRevision.content.file
		);
	const kind = output.kind;
	const openEditor = async () => {
		if (kind === "video") return;
		const { gadget } = await install.mutateAsync({
			workspaceId,
			outputId,
			kind,
		});
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
			queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			}),
		]);
		onOpenEditor(gadget.id);
	};
	return (
		<div className="grid gap-3" data-canvas-output-view="">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="grid min-w-0 gap-1">
					<CanvasOutputTitle outputId={output.id} title={output.title} />
					<Text role="body" tone="secondary">
						{outputWorkshopKindLabel(kind)} · Version {currentRevision.revision}
					</Text>
				</div>
				<div className="flex items-center gap-2">
					<OutputExportButtons
						outputId={output.id}
						kind={kind}
						content={currentRevision.content}
						compact
					/>
					{focusMode && onShare && <ShareButton compact onClick={onShare} />}
					{focusMode && onFocusModeChange && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Exit focus"
							title="Exit focus"
							onClick={() => onFocusModeChange(false)}
						>
							<ArrowsIn size={16} />
							<span className="sr-only">Exit focus</span>
						</Button>
					)}
				</div>
			</div>
			{editable && (
				<Alert>
					<AlertTitle>To make changes, open it in its editor</AlertTitle>
					<AlertDescription>
						The editor is an app in this workspace. The file and its version
						history stay where they are.
					</AlertDescription>
					<Button
						size="sm"
						onClick={() => void openEditor().catch(() => undefined)}
						disabled={install.isPending}
					>
						{install.isPending ? "Opening…" : "Open in editor"}
					</Button>
					{install.isError && (
						<Text role="body" tone="error">
							The editor could not be attached. You may need build access to
							this workspace.
						</Text>
					)}
				</Alert>
			)}
			<section aria-label="Saved version (read-only)">
				<OutputContentView content={currentRevision.content} />
			</section>
			<CanvasProposals
				workspaceId={workspaceId}
				documentType="output"
				documentId={outputId}
				onMerged={() => {
					void queryClient.invalidateQueries({
						queryKey: outputDetailQueryOptions(outputId).queryKey,
					});
				}}
			/>
		</div>
	);
}
