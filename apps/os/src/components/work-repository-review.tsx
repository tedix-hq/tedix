import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
	WorkAttemptRepositoryLifecycleSchema,
	WorkAttemptRepositorySchema,
	type WorkRepositoryReviewResult,
} from "@tedix/api-contract/schemas/work-items";
import { Link } from "@/components/kumo/link";
import { canvasDocKey } from "@/lib/canvas-search";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { workRepositoryReviewQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { RepositorySharedCandidate } from "@/components/repository-shared-candidate-editor";
import { WorkAttemptRepositoryPanel } from "@/components/work-attempt-repository-panel";
import { ProposalDiff } from "@/components/canvas-proposals";

function FileContent({ file }: { file: WorkRepositoryReviewResult["head"] }) {
	if (!file) return null;
	if (file.status !== "text")
		return (
			<Text role="label" tone="secondary">
				{file.status === "missing"
					? "File absent"
					: file.status === "binary"
						? "Binary file"
						: "File exceeds the 256 KiB preview limit"}
				{file.bytes !== null ? ` · ${file.bytes} bytes` : ""}
			</Text>
		);
	return (
		<pre className="m-0 max-h-96 overflow-auto whitespace-pre text-xs">
			<code>{file.text}</code>
		</pre>
	);
}

/** Retained content is loaded only on request, under the API's current access rules. */
export function WorkRepositoryReview({
	workItemId,
	attempt,
	canvasWorkspaceId,
}: {
	canvasWorkspaceId?: string;
	workItemId: string;
	attempt: {
		id: string;
		finishedAt?: string | null;
		metadata?: Record<string, unknown>;
	};
}) {
	const authority = useOsOperationalContext().data?.authority;
	const allowed = Boolean(
		(authority?.role === "owner" || authority?.role === "admin") &&
		authority.permissions.includes("secrets:manage"),
	);
	const repository = WorkAttemptRepositorySchema.safeParse(
		attempt.metadata?.repository,
	);
	const lifecycle = WorkAttemptRepositoryLifecycleSchema.safeParse(
		attempt.metadata?.repositoryLifecycle,
	);
	const available = Boolean(
		attempt.finishedAt &&
		repository.success &&
		repository.data.status === "ready" &&
		lifecycle.success,
	);
	const head = lifecycle.success ? lifecycle.data.headRevision : "0".repeat(40);
	const [open, setOpen] = useState(false);
	const [path, setPath] = useState("");
	const [file, setFile] = useState<string | null>(null);
	const [history, setHistory] = useState(false);
	const [offset, setOffset] = useState(0);
	const input = {
		id: workItemId,
		attemptId: attempt.id,
		expectedHeadRevision: head,
	};
	const tree = useQuery({
		...workRepositoryReviewQueryOptions({
			...input,
			operation: history ? "history" : "tree",
			path,
			offset,
		}),
		enabled: open && allowed && available,
	});
	const comparison = useQuery({
		...workRepositoryReviewQueryOptions({
			...input,
			operation: "compare",
			path: file ?? "",
			offset: 0,
		}),
		enabled: open && allowed && available && file !== null && !history,
	});
	if (!allowed || !attempt.metadata?.repository) return null;
	const canvasLink = canvasWorkspaceId ? (
		<Link
			href={`/workspace/${canvasWorkspaceId}?workpiece=${encodeURIComponent(canvasDocKey({ type: "repository", id: workItemId, attemptId: attempt.id }))}&pane=workpiece`}
		>
			Open repository in Canvas
		</Link>
	) : null;
	const sharedCandidate = (
		<RepositorySharedCandidate
			key="shared-candidate"
			workItemId={workItemId}
			attemptId={attempt.id}
			active={!attempt.finishedAt}
		/>
	);
	if (!attempt.finishedAt)
		return repository.success && repository.data.status === "ready" ? (
			<div className="grid gap-2">
				{canvasLink}
				<WorkAttemptRepositoryPanel
					workItemId={workItemId}
					attemptId={attempt.id}
					repository={repository.data}
				/>
				{sharedCandidate}
			</div>
		) : null;
	if (!available)
		return (
			<div className="grid gap-2">
				<Text role="label" tone="secondary">
					Retained repository result unavailable: this session has no immutable
					result receipt.
				</Text>
				{sharedCandidate}
			</div>
		);
	return (
		<div className="min-w-0 basis-full">
			{canvasLink}
			<Button
				size="sm"
				variant="secondary"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{open ? "Hide repository result" : "Review repository result"}
			</Button>
			{open ? (
				<section
					aria-label="Repository result"
					className="mt-2 grid min-w-0 gap-3"
				>
					<Text role="label" tone="secondary">
						Immutable recorded result. Review and deployment receipts are
						separate.
					</Text>
					<Text role="label" tone="mono-secondary" className="break-all">
						Base:{" "}
						{repository.success
							? (repository.data.baseRevision ?? "Empty repository")
							: "Unavailable"}
						<br />
						Result: {head}
					</Text>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setHistory(false);
								setPath("");
								setFile(null);
							}}
						>
							Files
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setHistory(true);
								setFile(null);
								setOffset(0);
							}}
						>
							History
						</Button>
						{path && !history ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setPath(path.split("/").slice(0, -1).join("/"));
									setFile(null);
								}}
							>
								Parent directory
							</Button>
						) : null}
					</div>
					{tree.isPending ? (
						<Text>Loading repository result…</Text>
					) : tree.isError ? (
						<Text tone="secondary">
							Repository result unavailable. Access or retained content may have
							changed.
						</Text>
					) : tree.data ? (
						<>
							{history ? (
								<>
									<ul className="m-0 grid list-none gap-2 p-0">
										{tree.data.commits.map((commit) => (
											<li key={commit.hash}>
												<Text
													as="p"
													className="m-0 whitespace-pre-wrap break-words"
												>
													{commit.message}
												</Text>
												<Text
													tone="mono-secondary"
													role="label"
													className="break-all"
												>
													{commit.hash}
												</Text>
											</li>
										))}
									</ul>
									<div className="flex gap-2">
										{offset ? (
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setOffset(Math.max(0, offset - 50))}
											>
												Newer commits
											</Button>
										) : null}
										{tree.data.nextOffset !== null ? (
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setOffset(tree.data!.nextOffset!)}
											>
												Older commits
											</Button>
										) : null}
									</div>
								</>
							) : (
								<>
									<Text role="label">/{path}</Text>
									<ul className="m-0 grid list-none gap-1 p-0">
										{tree.data.entries.map((entry) => (
											<li key={entry.name}>
												<Button
													size="sm"
													variant="ghost"
													disabled={
														entry.type === "gitlink" || entry.type === "symlink"
													}
													onClick={() => {
														const next = path
															? `${path}/${entry.name}`
															: entry.name;
														if (entry.type === "tree") {
															setPath(next);
															setFile(null);
														} else setFile(next);
													}}
												>
													{entry.name}
													{entry.type === "tree" ? "/" : ""} · {entry.change}
													{entry.type === "gitlink" || entry.type === "symlink"
														? ` · ${entry.type}`
														: ""}
												</Button>
											</li>
										))}
									</ul>
									{tree.data.truncated ? (
										<Text tone="secondary">
											Only the first 500 entries are shown.
										</Text>
									) : null}
								</>
							)}
						</>
					) : null}
					{file && !history && !tree.isError ? (
						<section
							aria-label={`Compare ${file}`}
							className="grid min-w-0 gap-2"
						>
							<Text weight="medium">{file}</Text>
							{comparison.isPending ? (
								<Text>Loading comparison…</Text>
							) : comparison.isError ? (
								<Text tone="secondary">File comparison unavailable.</Text>
							) : comparison.data ? (
								<>
									<Text role="label" tone="secondary">
										{comparison.data.base?.status === "text" &&
										comparison.data.head?.status === "text" &&
										comparison.data.base.text === comparison.data.head.text
											? "File unchanged"
											: "Base and recorded result"}
									</Text>
									{comparison.data.base &&
									comparison.data.head &&
									["text", "missing"].includes(comparison.data.base.status) &&
									["text", "missing"].includes(comparison.data.head.status) ? (
										<ProposalDiff
											baseText={comparison.data.base.text ?? ""}
											previewTextValue={comparison.data.head.text ?? ""}
											baseMoved={false}
										/>
									) : null}
									<div className="grid min-w-0 gap-4 lg:grid-cols-2">
										<div className="min-w-0">
											<Text as="h3" role="label">
												Base
											</Text>
											<FileContent file={comparison.data.base} />
										</div>
										<div className="min-w-0">
											<Text as="h3" role="label">
												Result
											</Text>
											<FileContent file={comparison.data.head} />
										</div>
									</div>
								</>
							) : null}
						</section>
					) : null}
				</section>
			) : null}
			{sharedCandidate}
		</div>
	);
}
