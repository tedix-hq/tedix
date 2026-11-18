import { ArrowLeft } from "@phosphor-icons/react";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { SavedOutputContentView } from "@/components/output-content";
import { osApi } from "@/lib/api";
import { fileActionRefusal } from "@/lib/file-action-refusal";
import { osQuery } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

interface VersionRow {
	revision: number;
	note: string | null;
	createdAt: string;
	createdByKind: "user" | "tedi" | "external_agent" | "service";
	author?: { name: string; self: boolean };
	savedBy?: { name: string | null; email: string };
}

/** Who saved a version, in the words the list shows. */
export function versionSavedBy(version: VersionRow): string {
	if (version.savedBy)
		return `${version.savedBy.name ?? version.savedBy.email} (share link)`;
	if (version.author) return version.author.self ? "You" : version.author.name;
	if (version.createdByKind === "user") return "A person";
	if (version.createdByKind === "service") return "An automation";
	return "An agent";
}

/**
 * Save an earlier version's content as the file's newest version. History
 * only grows: the versions in between stay where they are.
 */
async function restoreVersion(outputId: string, revision: number) {
	const [current, earlier] = await Promise.all([
		osApi.osWorkspaces.outputs.get({ outputId }),
		osApi.osWorkspaces.outputs.history({ outputId, revision }),
	]);
	const content = earlier.revisions.find(
		(item) => item.revision === revision,
	)?.content;
	if (!content) throw new Error("That version is no longer available.");
	return osApi.osWorkspaces.outputs.revise({
		outputId,
		content,
		expectedRevisionId: current.currentRevision.id,
		note: `Restored version ${revision}`,
	});
}

/** One earlier version, read-only. */
function VersionView({
	outputId,
	revision,
}: {
	outputId: string;
	revision: number;
}) {
	const version = useQuery(
		osQuery.osWorkspaces.outputs.history.queryOptions({
			input: { outputId, revision },
		}),
	);
	const content = version.data?.revisions[0]?.content;
	if (version.isPending)
		return <Skeleton className="h-40 rounded-xl" aria-busy="true" />;
	if (version.isError || !content)
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{version.isError
						? fileActionRefusal(version.error, "open this version")
						: "That version is no longer available."}
				</AlertDescription>
			</Alert>
		);
	return (
		<div data-version-content className="min-w-0 overflow-x-auto">
			<SavedOutputContentView outputId={outputId} content={content} />
		</div>
	);
}

/**
 * Every saved version of a file, newest first: who saved it, when, and its
 * note. A version can be read without changing anything, or restored.
 */
export function OutputVersionHistoryDialog({
	outputId,
	title,
	onClose,
}: {
	outputId: string;
	title: string;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [viewing, setViewing] = useState<number | null>(null);
	// The version asked about stays named while the confirmation closes.
	const [asked, setAsked] = useState(0);
	const [confirming, setConfirming] = useState(false);
	const history = useInfiniteQuery(
		osQuery.osWorkspaces.outputs.history.infiniteOptions({
			input: (beforeRevision: number | undefined) => ({
				outputId,
				beforeRevision,
			}),
			initialPageParam: undefined,
			getNextPageParam: (page) => page.nextBeforeRevision ?? undefined,
		}),
	);
	const versions: VersionRow[] =
		history.data?.pages.flatMap((page) => page.revisions) ?? [];
	const currentRevision = versions[0]?.revision;
	const restore = useMutation({
		mutationFn: (revision: number) => restoreVersion(outputId, revision),
		onSuccess: async () => {
			setConfirming(false);
			setViewing(null);
			// Every read of the files, including this paged list of versions.
			await queryClient.invalidateQueries({
				queryKey: osQuery.osWorkspaces.outputs.key(),
			});
		},
	});
	const askRestore = (revision: number) => {
		restore.reset();
		setAsked(revision);
		setConfirming(true);
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent size={viewing === null ? "base" : "xl"}>
				<DialogHeader>
					<DialogTitle>
						{viewing === null
							? "Version history"
							: `Version ${viewing} of “${title}”`}
					</DialogTitle>
					<DialogDescription>
						{viewing === null
							? `Every saved version of “${title}”. Restoring one saves it as a new version; nothing is deleted.`
							: "You are reading an earlier version. Nothing here can be edited."}
					</DialogDescription>
				</DialogHeader>
				{viewing !== null ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setViewing(null)}
							>
								<ArrowLeft size={14} /> All versions
							</Button>
							{viewing !== currentRevision && (
								<Button size="sm" onClick={() => askRestore(viewing)}>
									Restore this version
								</Button>
							)}
						</div>
						<VersionView outputId={outputId} revision={viewing} />
					</>
				) : history.isPending ? (
					<div className="grid gap-2" aria-busy="true">
						<Skeleton className="h-12 rounded-lg" />
						<Skeleton className="h-12 rounded-lg" />
					</div>
				) : history.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							{fileActionRefusal(history.error, "show this file's versions")}
						</AlertDescription>
					</Alert>
				) : (
					<>
						<ol className="grid gap-1" aria-label="Versions">
							{versions.map((version) => (
								<li
									key={version.revision}
									data-version={version.revision}
									className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-kumo-hairline p-3"
								>
									<div className="grid min-w-0 gap-0.5">
										<span className="flex flex-wrap items-center gap-2">
											<Text as="span" role="body" className="font-medium">
												Version {version.revision}
											</Text>
											{version.revision === currentRevision && (
												<Badge variant="secondary">Current</Badge>
											)}
										</span>
										<Text as="span" role="label" tone="secondary">
											{versionSavedBy(version)} ·{" "}
											<time
												dateTime={version.createdAt}
												title={absoluteTime(version.createdAt)}
											>
												{relativeTime(version.createdAt)}
											</time>
										</Text>
										{version.note && (
											<Text
												as="span"
												role="label"
												tone="secondary"
												className="[overflow-wrap:anywhere]"
											>
												{version.note}
											</Text>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<Button
											variant="outline"
											size="sm"
											aria-label={`View version ${version.revision}`}
											onClick={() => setViewing(version.revision)}
										>
											View
										</Button>
										{version.revision !== currentRevision && (
											<Button
												variant="outline"
												size="sm"
												aria-label={`Restore version ${version.revision}`}
												onClick={() => askRestore(version.revision)}
											>
												Restore this version
											</Button>
										)}
									</div>
								</li>
							))}
						</ol>
						{history.hasNextPage && (
							<Button
								variant="outline"
								size="sm"
								loading={history.isFetchingNextPage}
								disabled={history.isFetchingNextPage}
								onClick={() => void history.fetchNextPage()}
							>
								Show older versions
							</Button>
						)}
					</>
				)}
				{/* Inside this dialog, so confirming counts as part of it and does
					    not close it as a click outside would. */}
				<ConfirmDialog
					open={confirming}
					onOpenChange={setConfirming}
					title={`Restore version ${asked}?`}
					description={`“${title}” goes back to what it was in version ${asked}, saved as a new version. Nothing is deleted: every version stays in the history, so you can return to today's version the same way.`}
					confirmLabel="Restore"
					pendingLabel="Restoring…"
					retryLabel="Try again"
					isPending={restore.isPending}
					error={
						restore.error
							? fileActionRefusal(restore.error, "restore this version")
							: undefined
					}
					onConfirm={() => restore.mutate(asked)}
				/>
			</DialogContent>
		</Dialog>
	);
}
