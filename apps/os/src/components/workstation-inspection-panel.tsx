import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { workstationInspectionStatusQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

type Entry = {
	path: string;
	status: string;
	rawStatus: string;
	untracked: boolean;
};
type InspectionProvenance = {
	baselineSha: string;
	currentSha: string;
	generationId: string;
	observedAt: string;
};

export function sameInspectionProvenance(
	inventory: InspectionProvenance,
	file: InspectionProvenance,
): boolean {
	return (
		inventory.baselineSha === file.baselineSha &&
		inventory.currentSha === file.currentSha &&
		inventory.generationId === file.generationId &&
		Date.parse(file.observedAt) >= Date.parse(inventory.observedAt)
	);
}

function statusLabel(entry: Entry): string {
	return entry.status
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function decodeWorkstationInspectionText(value: string): string | null {
	try {
		const bytes = Uint8Array.from(atob(value), (character) =>
			character.charCodeAt(0),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function decodeWorkstationInventory(result: {
	files?: Entry[];
}): Entry[] | null {
	return result.files ?? null;
}

export function WorkstationInspectionPanel({
	workItemId,
	attemptId,
}: {
	workItemId: string;
	attemptId: string;
}) {
	const operationalContext = useOsOperationalContext();
	const authority = operationalContext.data?.authority;
	const canInspectRawRepository = Boolean(
		(authority?.role === "owner" || authority?.role === "admin") &&
		authority.permissions.includes("secrets:manage"),
	);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<{
		path: string;
		data: Awaited<ReturnType<typeof osApi.workItems.inspectAttemptRepository>>;
	} | null>(null);
	const request = useRef(0);
	const status = useQuery({
		...workstationInspectionStatusQueryOptions(workItemId, attemptId),
		enabled: open && canInspectRawRepository,
	});
	const content = useMutation({
		onMutate: () => setSelected(null),
		mutationFn: async ({ entry, token }: { entry: Entry; token: number }) => ({
			token,
			path: entry.path,
			data: await osApi.workItems.inspectAttemptRepository({
				id: workItemId,
				attemptId,
				operation: entry.untracked ? "read" : "diff",
				path: entry.path,
			}),
		}),
		onSuccess: (value) => {
			if (value.token === request.current) setSelected(value);
		},
	});
	const inventory = status.data
		? decodeWorkstationInventory(status.data)
		: null;
	const selectedIsCurrent =
		selected && status.data
			? sameInspectionProvenance(status.data, selected.data)
			: false;
	const incompleteInventory = Boolean(
		status.data?.timedOut || status.data?.truncated,
	);
	const refresh = () => {
		request.current += 1;
		setSelected(null);
		content.reset();
		void status.refetch();
	};
	if (!canInspectRawRepository)
		return (
			<Text role="label" tone="secondary">
				Raw changes require owner or admin access and secrets management
				permission.
			</Text>
		);
	return (
		<div className="mt-2 min-w-0">
			<Button
				size="sm"
				variant="secondary"
				aria-expanded={open}
				onClick={() => {
					request.current += 1;
					setSelected(null);
					content.reset();
					setOpen((value) => !value);
				}}
			>
				{open ? "Hide changes" : "Changes"}
			</Button>
			{open ? (
				status.isPending ? (
					<Text role="label">Loading changes…</Text>
				) : status.isError ? (
					<Text role="label" tone="secondary">
						Changes unavailable.
					</Text>
				) : inventory === null ? (
					<Text role="label">Invalid change inventory.</Text>
				) : inventory.length === 0 && !incompleteInventory ? (
					<Text role="label" tone="secondary">
						No working tree changes.
					</Text>
				) : (
					<ul className="mt-2 space-y-1">
						{inventory.map((entry) => (
							<li key={`${entry.status}:${entry.path}`}>
								<Button
									variant="ghost"
									size="sm"
									aria-pressed={
										selectedIsCurrent && selected?.path === entry.path
									}
									onClick={() =>
										content.mutate({ entry, token: ++request.current })
									}
								>
									{statusLabel(entry)} · {entry.path}
								</Button>
							</li>
						))}
					</ul>
				)
			) : null}
			{open && status.data ? (
				<div className="mt-2 grid gap-1">
					<Text role="label" tone="secondary">
						Inventory observed{" "}
						{new Date(status.data.observedAt).toLocaleString()} · baseline{" "}
						{status.data.baselineSha.slice(0, 12)} · current{" "}
						{status.data.currentSha.slice(0, 12)} · generation{" "}
						{status.data.generationId} · non-atomic snapshot
					</Text>
					{incompleteInventory ? (
						<Text role="label">
							Inventory incomplete · {status.data.truncationReasons.join(", ")}.
							Files shown may not be the full change set.
						</Text>
					) : null}
				</div>
			) : null}
			{open && !status.isPending ? (
				<Button size="sm" variant="secondary" onClick={refresh}>
					Refresh changes
				</Button>
			) : null}
			{open && content.isPending ? (
				<Text role="label">Loading file…</Text>
			) : null}
			{open && content.isError ? (
				<Text role="label">File inspection unavailable.</Text>
			) : null}
			{open && selected && !selectedIsCurrent ? (
				<Text role="label">
					File view is stale: its baseline, current commit, or workstation
					generation differs from the inventory. Refresh changes before
					reviewing it.
				</Text>
			) : null}
			{open && selected && selectedIsCurrent ? (
				<div className="mt-2">
					<Text role="label" tone="mono-secondary">
						{selected.path}
					</Text>
					<Text role="label" tone="secondary">
						Observed {new Date(selected.data.observedAt).toLocaleString()} ·
						baseline {selected.data.baselineSha.slice(0, 12)} · current{" "}
						{selected.data.currentSha.slice(0, 12)} · generation{" "}
						{selected.data.generationId} · non-atomic snapshot
					</Text>
					<Text role="label" tone="secondary">
						{selected.data.kind === "symlink"
							? "Symlink"
							: selected.data.kind === "file"
								? "Untracked file"
								: "Diff"}
						{selected.data.size === undefined
							? ""
							: ` · ${selected.data.size} bytes`}
						{selected.data.truncated ? " · truncated" : ""}
						{selected.data.timedOut ? " · timed out" : ""}
					</Text>
					{selected.data.truncationReasons.length > 0 ? (
						<Text role="label">
							Partial inspection · {selected.data.truncationReasons.join(", ")}
						</Text>
					) : null}
					{selected.data.timedOut || selected.data.exitCode !== 0 ? (
						<Text role="label">
							File inspection did not complete; refresh changes and retry.
						</Text>
					) : selected.data.binary || selected.data.skipReason === "binary" ? (
						<Text role="label">
							Binary file
							{selected.data.size === undefined
								? ""
								: ` · ${selected.data.size} bytes`}
						</Text>
					) : selected.data.skipReason ? (
						<Text role="label">
							Structured view unavailable · {selected.data.skipReason}
						</Text>
					) : selected.data.hunks?.length ? (
						<div className="mt-2 grid gap-2">
							{selected.data.hunks.map((hunk, index) => (
								<div key={`${hunk.header}:${index}`}>
									<pre className="overflow-auto bg-kumo-control/40 px-2 py-1 text-xs">
										{hunk.header}
									</pre>
									<pre className="max-h-96 overflow-auto text-xs">
										{hunk.lines.map((line, lineIndex) => (
											<span
												key={`${lineIndex}:${line.oldLine}:${line.newLine}`}
												className={
													line.kind === "addition"
														? "block bg-[var(--tedix-hue-green-tint)]"
														: line.kind === "deletion"
															? "block bg-[var(--tedix-hue-red-tint)]"
															: "block"
												}
											>
												{String(line.oldLine ?? "").padStart(4)}{" "}
												{String(line.newLine ?? "").padStart(4)}{" "}
												{line.kind === "addition"
													? "+"
													: line.kind === "deletion"
														? "-"
														: " "}
												{line.content}
											</span>
										))}
									</pre>
								</div>
							))}
						</div>
					) : (
						<Text role="label" tone="secondary">
							No textual hunks for this path.
						</Text>
					)}
					{!selected.data.binary ? (
						<details className="mt-2">
							<summary className="cursor-pointer text-xs">Raw fallback</summary>
							<pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
								{decodeWorkstationInspectionText(selected.data.dataBase64) ??
									"Content is not valid UTF-8."}
							</pre>
						</details>
					) : null}
				</div>
			) : null}
		</div>
	);
}
