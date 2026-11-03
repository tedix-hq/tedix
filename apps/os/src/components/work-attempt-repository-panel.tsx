import type { WorkAttemptRepository } from "@tedix/api-contract/schemas/work-items";
import { WorkAttemptRepositorySchema } from "@tedix/api-contract/schemas/work-items";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ProposalDiff } from "@/components/canvas-proposals";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { decodeWorkstationInspectionText } from "@/components/workstation-inspection-panel";
import { osApi } from "@/lib/api";
import { absoluteTime } from "@/lib/time";
import {
	attemptRepositoryLogQueryOptions,
	attemptRepositoryTreeQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/** The ready Artifacts repository recorded on an Attempt's metadata, if any. */
export function readyAttemptRepository(
	metadata?: Record<string, unknown>,
): WorkAttemptRepository | null {
	const parsed = WorkAttemptRepositorySchema.safeParse(metadata?.repository);
	return parsed.success && parsed.data.status === "ready" ? parsed.data : null;
}

/**
 * Immutable review of an Attempt's Artifacts repository: first-parent
 * history, a tree browser pinned to the resolved head, and per-file reads with
 * an optional comparison against the recorded base revision. Unlike the live
 * workstation inspection this stays available after the Attempt settles; it
 * carries the same secrets-management gate because repository bytes are
 * executor-produced.
 */
export function WorkAttemptRepositoryPanel({
	workItemId,
	attemptId,
	repository,
}: {
	workItemId: string;
	attemptId: string;
	repository: WorkAttemptRepository;
}) {
	const operationalContext = useOsOperationalContext();
	const authority = operationalContext.data?.authority;
	const canRead = Boolean(
		(authority?.role === "owner" || authority?.role === "admin") &&
		authority.permissions.includes("secrets:manage"),
	);
	const [open, setOpen] = useState(false);
	const [segments, setSegments] = useState<string[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [compare, setCompare] = useState(false);
	const log = useQuery({
		...attemptRepositoryLogQueryOptions(workItemId, attemptId),
		enabled: open && canRead,
	});
	const head = log.data?.operation === "log" ? log.data.resolvedRevision : null;
	const dirPath = segments.join("/");
	const tree = useQuery({
		...attemptRepositoryTreeQueryOptions(
			workItemId,
			attemptId,
			head ?? "",
			dirPath || undefined,
		),
		enabled: open && canRead && !!head,
	});
	const file = useMutation({
		mutationFn: (path: string) =>
			osApi.workItems.readAttemptRepository({
				id: workItemId,
				attemptId,
				operation: "file",
				ref: head!,
				path,
			}),
	});
	const baseFile = useMutation({
		mutationFn: (path: string) =>
			osApi.workItems.readAttemptRepository({
				id: workItemId,
				attemptId,
				operation: "file",
				ref: repository.baseRevision!,
				path,
			}),
	});
	if (!canRead)
		return (
			<Text role="label" tone="secondary">
				Repository review requires owner or admin access and secrets management
				permission.
			</Text>
		);
	const openFile = (path: string) => {
		setSelected(path);
		setCompare(false);
		baseFile.reset();
		file.mutate(path);
	};
	const treeData = tree.data?.operation === "tree" ? tree.data : null;
	const fileData = file.data?.operation === "file" ? file.data : null;
	const fileText =
		fileData?.exists && fileData.dataBase64 && !fileData.binary
			? decodeWorkstationInspectionText(fileData.dataBase64)
			: null;
	const baseData = baseFile.data?.operation === "file" ? baseFile.data : null;
	const baseText =
		baseData?.exists && baseData.dataBase64 && !baseData.binary
			? decodeWorkstationInspectionText(baseData.dataBase64)
			: null;
	return (
		<div className="mt-2 min-w-0" data-attempt-repository>
			<Button
				size="sm"
				variant="secondary"
				aria-expanded={open}
				onClick={() => {
					setSegments([]);
					setSelected(null);
					setCompare(false);
					file.reset();
					baseFile.reset();
					setOpen((value) => !value);
				}}
			>
				{open ? "Hide repository" : "Repository"}
			</Button>
			{open ? (
				<div className="mt-2 grid min-w-0 gap-2">
					<Text role="label" tone="secondary">
						Repository {repository.repositoryName} · branch{" "}
						{repository.defaultBranch ?? "unknown"} · base{" "}
						{repository.baseRevision?.slice(0, 12) ?? "not recorded"} ·{" "}
						{repository.mode === "fork" ? "fork" : "created"} snapshot
					</Text>
					{log.isPending ? (
						<Text role="label">Loading history…</Text>
					) : log.isError ? (
						<Text role="label" tone="secondary">
							Repository history unavailable.
						</Text>
					) : log.data?.operation === "log" ? (
						log.data.commits.length ? (
							<ul className="grid gap-1" aria-label="Commit history">
								{log.data.commits.map((commit) => (
									<li
										key={commit.hash}
										className="flex min-w-0 flex-wrap items-baseline gap-x-2"
									>
										<code className="shrink-0 text-xs">
											{commit.hash.slice(0, 10)}
										</code>
										<Text as="span" role="label" className="min-w-0 truncate">
											{commit.message.split("\n", 1)[0]}
										</Text>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="shrink-0"
										>
											{commit.author.name} ·{" "}
											<time
												dateTime={commit.committedAt}
												title={absoluteTime(commit.committedAt)}
											>
												{absoluteTime(commit.committedAt)}
											</time>
										</Text>
									</li>
								))}
							</ul>
						) : (
							<Text role="label" tone="secondary">
								The repository has no commits yet.
							</Text>
						)
					) : null}
					{head ? (
						<div className="grid min-w-0 gap-1" aria-label="Files">
							<div className="flex min-w-0 flex-wrap items-center gap-1">
								<Text role="label" tone="mono-secondary">
									{dirPath ? `${dirPath}/` : "/"} · at {head.slice(0, 12)}
								</Text>
								{segments.length ? (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setSegments(segments.slice(0, -1))}
									>
										Up
									</Button>
								) : null}
							</div>
							{tree.isPending ? (
								<Text role="label">Loading files…</Text>
							) : tree.isError ? (
								<Text role="label" tone="secondary">
									File listing unavailable.
								</Text>
							) : treeData && !treeData.exists ? (
								<Text role="label" tone="secondary">
									This directory does not exist at {head.slice(0, 12)}.
								</Text>
							) : treeData && treeData.entries.length === 0 ? (
								<Text role="label" tone="secondary">
									Empty directory.
								</Text>
							) : treeData ? (
								<>
									<ul className="grid gap-0.5">
										{treeData.entries.map((entry) => (
											<li key={entry.path}>
												<Button
													variant="ghost"
													size="sm"
													aria-pressed={selected === entry.path}
													onClick={() =>
														entry.type === "tree"
															? setSegments([...segments, entry.name])
															: openFile(entry.path)
													}
												>
													{entry.type === "tree"
														? `${entry.name}/`
														: entry.name}
												</Button>
											</li>
										))}
									</ul>
									{treeData.truncated ? (
										<Text role="label">Listing truncated at 500 entries.</Text>
									) : null}
								</>
							) : null}
						</div>
					) : null}
					{file.isPending ? <Text role="label">Loading file…</Text> : null}
					{file.isError ? (
						<Text role="label">File read unavailable.</Text>
					) : null}
					{fileData && selected === fileData.path ? (
						<div
							className="grid min-w-0 gap-1"
							data-attempt-repository-file={selected}
						>
							<Text role="label" tone="mono-secondary">
								{selected}
							</Text>
							<Text role="label" tone="secondary">
								{fileData.exists
									? `${fileData.size ?? "?"} bytes${
											fileData.binary ? " · binary" : ""
										}${fileData.truncated ? " · truncated" : ""}`
									: "Not present at this revision"}
							</Text>
							{fileData.exists && fileData.binary ? (
								<Text role="label">Binary file.</Text>
							) : fileData.exists && fileText === null ? (
								<Text role="label">Content is not valid UTF-8.</Text>
							) : fileText === null ? null : (
								<pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
									{fileText}
								</pre>
							)}
							{fileData.exists &&
							!fileData.binary &&
							fileText !== null &&
							repository.baseRevision ? (
								<div className="grid gap-1">
									<Button
										size="sm"
										variant="secondary"
										aria-pressed={compare}
										disabled={baseFile.isPending}
										onClick={() => {
											setCompare(!compare);
											if (!compare) baseFile.mutate(selected);
										}}
									>
										{baseFile.isPending
											? "Comparing…"
											: compare
												? "Hide base comparison"
												: "Compare to base"}
									</Button>
									{compare && baseFile.isError ? (
										<Text role="label">Base revision read unavailable.</Text>
									) : null}
									{compare && baseData ? (
										baseText !== null ? (
											<ProposalDiff
												baseText={baseText}
												previewTextValue={fileText}
												baseMoved={false}
											/>
										) : (
											<Text role="label" tone="secondary">
												The file is absent or binary at the recorded base
												revision.
											</Text>
										)
									) : null}
								</div>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
