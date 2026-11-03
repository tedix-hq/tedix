import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
	RepositoryCandidateDescriptor,
	RepositoryCandidateState,
} from "@tedix/api-contract/schemas/repository-candidate";
import { CanvasCodeEditor } from "@/components/canvas-editor";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { repositoryCandidateQueryOptions } from "@/lib/os-query-options";
import { useWorkspaceVerificationPaused } from "@/lib/workspace-verification";
import { useCollabDoc } from "@/lib/use-collab-doc";

/** Opening a candidate reads the current executor's frozen selection; it never starts another writer. */
export function RepositorySharedCandidate({
	workItemId,
	attemptId,
	active,
}: {
	workItemId: string;
	attemptId: string;
	active: boolean;
}) {
	const [opened, setOpened] = useState(false);
	const verificationPaused = useWorkspaceVerificationPaused();
	const candidate = useQuery({
		...repositoryCandidateQueryOptions(workItemId, attemptId),
		enabled: opened && active && !verificationPaused,
		refetchInterval: (query) =>
			opened &&
			active &&
			!verificationPaused &&
			query.state.status !== "error" &&
			!query.state.data?.state.sealed
				? 3000
				: false,
	});
	if (!opened)
		return active ? (
			<Button
				size="sm"
				variant="secondary"
				disabled={verificationPaused}
				onClick={() => setOpened(true)}
			>
				Open shared code candidate
			</Button>
		) : null;
	return (
		<section
			className="grid min-w-0 gap-3"
			aria-label="Shared repository candidate"
		>
			{candidate.isError && (
				<Text tone="warning">
					{candidate.error.message}
					{candidate.error.message.includes("not initialized")
						? " Ask the current executor on this Work to initialize a bounded selection of existing text files."
						: " Shared editing is unavailable. Keep a copy of your edits before retrying."}
				</Text>
			)}
			{candidate.data ? (
				<RepositorySharedCandidateEditor
					key={candidate.data.descriptor.docKey}
					workItemId={workItemId}
					descriptor={candidate.data.descriptor}
					state={candidate.data.state}
					readOnly={
						!active ||
						verificationPaused ||
						candidate.isError ||
						candidate.data.state.sealed
					}
				/>
			) : candidate.isPending && active ? (
				<Text>Loading the executor's shared candidate…</Text>
			) : null}
		</section>
	);
}

function RepositorySharedCandidateEditor({
	workItemId,
	descriptor,
	state,
	readOnly,
}: {
	workItemId: string;
	descriptor: RepositoryCandidateDescriptor;
	state: RepositoryCandidateState;
	readOnly: boolean;
}) {
	const [path, setPath] = useState(descriptor.files[0]!.path);
	const room = useCollabDoc({
		workItemId,
		docKey: descriptor.docKey,
		enabled: true,
		paused: readOnly,
		canonical: {
			text: "",
			files: state.snapshot.files,
			revision: 0,
			revisionId: descriptor.baseRevision,
		},
	});
	return (
		<div className="grid min-w-0 gap-2">
			<Text>
				Shared candidate at {descriptor.baseRevision.slice(0, 12)}. These edits
				have not been written to the repository. The current executor must
				review and apply them through the existing Work.
			</Text>
			<Text role="label" tone="secondary">
				{state.sealed
					? "Candidate sealed"
					: room.status === "connected"
						? `${room.peers} connected`
						: "Shared editing paused"}
			</Text>
			{readOnly && (
				<Text tone="warning">
					This candidate is read-only. Keep a copy of your code before leaving.
				</Text>
			)}
			<div className="flex flex-wrap gap-1">
				{descriptor.files.map((file) => (
					<Button
						key={file.path}
						size="sm"
						variant={file.path === path ? "secondary" : "ghost"}
						onClick={() => setPath(file.path)}
					>
						{file.path}
					</Button>
				))}
			</div>
			{room.session && (
				<CanvasCodeEditor
					session={room.session}
					path={path}
					readOnly={
						readOnly ||
						room.status !== "connected" ||
						room.recoveryRequired ||
						room.recoverableFiles !== null
					}
				/>
			)}
			{room.recoverableFiles && (
				<div className="grid gap-2">
					<Text tone="warning">
						The connection interrupted unsynced edits. Copy this retained code
						and compare it with the shared files before continuing.
					</Text>
					<Textarea
						aria-label="Retained unsynced repository code"
						rows={8}
						readOnly
						value={JSON.stringify(room.recoverableFiles, null, 2)}
					/>
					<Button
						size="sm"
						variant="secondary"
						onClick={room.clearRecoverableFiles}
					>
						I have reviewed my copy; use shared code
					</Button>
				</div>
			)}
			{room.recoveryRequired && (
				<Text tone="warning">
					The candidate no longer matches this editor. Keep a copy and compare
					before reopening.
				</Text>
			)}
			{room.blocked && <Text tone="warning">{room.blocked.message}</Text>}
			{room.tooLarge && (
				<Text tone="warning">
					This candidate exceeds the shared editor limit.
				</Text>
			)}
			{!readOnly && room.status !== "connected" && (
				<Button size="sm" variant="secondary" onClick={room.retry}>
					Reconnect shared candidate
				</Button>
			)}
		</div>
	);
}
