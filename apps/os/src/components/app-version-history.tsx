import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/kumo/alert";
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
import { versionSavedBy } from "@/components/output-version-history";
import { osApi } from "@/lib/api";
import { fileActionRefusal } from "@/lib/file-action-refusal";
import {
	appRuntimeRevisionsQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

/**
 * Every saved version of an app, newest first. Restoring one saves its code
 * and settings as the app's newest version; the versions in between stay.
 */
export function AppVersionHistoryDialog({
	workspaceId,
	gadgetId,
	title,
	onClose,
}: {
	workspaceId: string;
	gadgetId: string;
	title: string;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [asked, setAsked] = useState<{ id: string; revision: number } | null>(
		null,
	);
	const history = useQuery(
		appRuntimeRevisionsQueryOptions(workspaceId, gadgetId),
	);
	const versions = history.data?.revisions ?? [];
	const current = versions[0];
	const restore = useMutation({
		mutationFn: (revisionId: string) => {
			if (!current) throw new Error("The current version is not loaded");
			return osApi.osAppRuntime.restoreRevision({
				workspaceId,
				gadgetId,
				revisionId,
				expectedRevisionId: current.id,
			});
		},
		onSuccess: async () => {
			setAsked(null);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
				queryClient.invalidateQueries({
					queryKey: osQuery.osAppRuntime.key(),
				}),
			]);
		},
	});
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent size="base">
				<DialogHeader>
					<DialogTitle>Version history</DialogTitle>
					<DialogDescription>
						{`Every saved version of “${title}”. Restoring one saves it as a new version; nothing is deleted.`}
					</DialogDescription>
				</DialogHeader>
				{history.isPending ? (
					<ListSkeleton rows={2} rowClassName="h-12" />
				) : history.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							{fileActionRefusal(history.error, "show this app's versions")}
						</AlertDescription>
					</Alert>
				) : (
					<ol className="grid gap-1" aria-label="Versions">
						{versions.map((version) => (
							<li
								key={version.id}
								data-version={version.revision}
								className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-kumo-hairline p-3"
							>
								<div className="grid min-w-0 gap-0.5">
									<span className="flex flex-wrap items-center gap-2">
										<Text as="span" role="body" className="font-medium">
											Version {version.revision}
										</Text>
										{version.id === current?.id && (
											<Badge variant="secondary">Current</Badge>
										)}
									</span>
									<Text as="span" role="label" tone="secondary">
										{versionSavedBy({ ...version, note: null })} ·{" "}
										<time
											dateTime={version.createdAt}
											title={absoluteTime(version.createdAt)}
										>
											{relativeTime(version.createdAt)}
										</time>
									</Text>
								</div>
								{version.id !== current?.id && (
									<Button
										variant="outline"
										size="sm"
										aria-label={`Restore version ${version.revision}`}
										onClick={() => {
											restore.reset();
											setAsked({ id: version.id, revision: version.revision });
										}}
									>
										Restore this version
									</Button>
								)}
							</li>
						))}
					</ol>
				)}
				<ConfirmDialog
					open={asked !== null}
					onOpenChange={(open) => !open && setAsked(null)}
					title={`Restore version ${asked?.revision ?? ""}?`}
					description={`“${title}” goes back to its code and settings from version ${asked?.revision ?? ""}, saved as a new version. Nothing is deleted: every version stays in the history, so you can return to today's version the same way.`}
					confirmLabel="Restore"
					pendingLabel="Restoring…"
					retryLabel="Try again"
					isPending={restore.isPending}
					error={
						restore.error
							? fileActionRefusal(restore.error, "restore this version")
							: undefined
					}
					onConfirm={() => asked && restore.mutate(asked.id)}
				/>
			</DialogContent>
		</Dialog>
	);
}
