import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ProposalDiff } from "@/components/canvas-proposals";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	type AppEditRequest,
	type PendingAppEdit,
	usePendingAppEdits,
} from "@/lib/app-edit-approval";
import { appDraftFileChanges } from "@/lib/app-runtime-drafts";
import {
	appRuntimeCodeQueryOptions,
	appRuntimeRevisionsQueryOptions,
	canvasGadgetDetailQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

const KIND_LABEL = {
	added: "New file",
	changed: "Changed",
	removed: "Removed",
};

/** The revision the edit was written against, falling back to the live one. */
function useBaseRevision(workspaceId: string, edit: AppEditRequest) {
	const detail = useQuery(
		canvasGadgetDetailQueryOptions(workspaceId, edit.appId),
	);
	const live = detail.data?.currentRevision ?? null;
	const revisions = useQuery({
		...appRuntimeRevisionsQueryOptions(workspaceId, edit.appId),
		enabled: !!live,
	});
	const base =
		revisions.data?.revisions.find(
			(revision) => revision.revision === edit.expectedRevision,
		) ?? (live?.revision === edit.expectedRevision ? live : null);
	const code = useQuery({
		...appRuntimeCodeQueryOptions(workspaceId, edit.appId, base?.id),
		enabled: !!base,
	});
	return { live, base, files: code.data?.code?.files ?? null };
}

/** What the edit changes, file by file, in plain words. */
export function AppEditDiff({
	workspaceId,
	edit,
}: {
	workspaceId: string;
	edit: AppEditRequest;
}) {
	const { base, files } = useBaseRevision(workspaceId, edit);
	const changes = useMemo(
		() =>
			base && files
				? appDraftFileChanges(
						{ manifest: base.manifest, files },
						{ manifest: base.manifest, files: edit.files },
					)
				: null,
		[base, files, edit.files],
	);
	if (!changes)
		return (
			<Text as="p" role="label" tone="secondary" className="m-0">
				Loading what this changes…
			</Text>
		);
	if (changes.length === 0)
		return (
			<Text as="p" role="label" tone="secondary" className="m-0">
				This edit matches version {edit.expectedRevision}. Nothing would change.
			</Text>
		);
	return (
		<div className="grid min-w-0 gap-2" data-app-edit-diff>
			{changes.map((change) => (
				<div key={change.path} className="grid min-w-0 gap-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<code className="truncate text-sm">{change.path}</code>
						<Badge variant="secondary">{KIND_LABEL[change.kind]}</Badge>
					</div>
					<ProposalDiff
						baseText={change.before}
						previewTextValue={change.after}
						baseMoved={false}
					/>
				</div>
			))}
		</div>
	);
}

/** After an applied edit: put the previous revision back as a new version. */
export function AppEditUndo({
	workspaceId,
	edit,
}: {
	workspaceId: string;
	edit: AppEditRequest;
}) {
	const queryClient = useQueryClient();
	const { live, base } = useBaseRevision(workspaceId, edit);
	const [restored, setRestored] = useState(false);
	const undo = useMutation({
		mutationFn: () => {
			if (!live || !base) throw new Error("The earlier version is not loaded");
			return osApi.osAppRuntime.restoreRevision({
				workspaceId,
				gadgetId: edit.appId,
				revisionId: base.id,
				expectedRevisionId: live.id,
			});
		},
		onSuccess: async () => {
			setRestored(true);
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() });
		},
	});
	if (restored || (live && live.revision > edit.expectedRevision + 1))
		return restored ? (
			<Text as="p" role="caption" tone="success" className="m-0">
				Restored version {edit.expectedRevision}.
			</Text>
		) : null;
	if (!live || !base || live.revision !== edit.expectedRevision + 1)
		return null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				size="sm"
				variant="outline"
				disabled={undo.isPending}
				onClick={() => undo.mutate()}
			>
				{undo.isPending
					? "Undoing…"
					: `Undo (back to version ${base.revision})`}
			</Button>
			{undo.error && (
				<Text as="span" role="caption" tone="error">
					{(undo.error as Error).message}
				</Text>
			)}
		</div>
	);
}

/** The open app's banner: a chat edit waiting for a decision, with the diff. */
export function PendingAppEditBanner({
	workspaceId,
	appId,
}: {
	workspaceId: string;
	appId: string;
}) {
	const edits = usePendingAppEdits(workspaceId, appId);
	if (edits.length === 0) return null;
	return (
		<div className="grid gap-3" data-app-edit-pending>
			{edits.map((edit) => (
				<PendingCard key={edit.approvalId} edit={edit} />
			))}
		</div>
	);
}

function PendingCard({ edit }: { edit: PendingAppEdit }) {
	const [sent, setSent] = useState(false);
	const decide = (decision: "approve" | "deny") => {
		setSent(true);
		edit.decide(decision);
	};
	return (
		<section
			className="canvas-drafts-banner grid min-w-0 gap-2"
			role="status"
			aria-label="Change from chat"
		>
			<Text as="strong" role="label">
				Chat wants to change this app. The live app stays on version{" "}
				{edit.expectedRevision} until you accept.
			</Text>
			<AppEditDiff workspaceId={edit.workspaceId} edit={edit} />
			<div className="flex gap-2">
				<Button size="sm" disabled={sent} onClick={() => decide("approve")}>
					Accept
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={sent}
					onClick={() => decide("deny")}
				>
					Reject
				</Button>
			</div>
		</section>
	);
}
