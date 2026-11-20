import {
	CaretRight,
	Check,
	Desktop,
	FileText,
	GitCommit,
	type Icon,
	ListChecks,
	MagnifyingGlass,
	PencilSimple,
	Robot,
	Terminal,
	Warning,
	Wrench,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import {
	type MachineAction,
	type MachineActionKind,
	machineDiffLines,
	summarizeMachineActions,
} from "@/lib/machine-activity";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { cn } from "@/lib/utils";

/** Lines of a result shown before "Show more". */
const COMPACT_LINES = 12;

const KIND: Record<MachineActionKind, { label: string; icon: Icon }> = {
	read: { label: "Read", icon: FileText },
	search: { label: "Search", icon: MagnifyingGlass },
	commits: { label: "Commits", icon: GitCommit },
	commit: { label: "Commit", icon: GitCommit },
	ci: { label: "CI", icon: ListChecks },
	ci_log: { label: "CI log", icon: ListChecks },
	runner: { label: "Runner", icon: Robot },
	edit: { label: "Edit", icon: PencilSimple },
	write: { label: "Write", icon: PencilSimple },
	command: { label: "Command", icon: Terminal },
	machines: { label: "Machines", icon: Desktop },
	other: { label: "Machine", icon: Wrench },
};

const STATUS_LABEL = {
	running: "Running",
	waiting: "Waiting",
	done: "Done",
	failed: "Failed",
} as const;

export type MachineToolCallResult = {
	status: string;
	result?: string;
	error?: string;
};

/**
 * Reads a machine tool call again for its full result. The stored events keep
 * only the start of a result; the call itself keeps all of it. Only the one
 * who queued the call or an organization admin may read it.
 */
export async function readMachineToolCallResult(
	callId: string,
): Promise<MachineToolCallResult> {
	const { osApi } = await import("@/lib/api");
	return osApi.machines.readToolCall({ callId });
}

type Line = { sign: " " | "+" | "-"; text: string };

/** Monospace lines, cut after a dozen with the rest one click away. */
function Lines({ lines, label }: { lines: readonly Line[]; label: string }) {
	const [all, setAll] = useState(false);
	const hidden = all ? 0 : Math.max(0, lines.length - COMPACT_LINES);
	const shown = hidden ? lines.slice(0, COMPACT_LINES) : lines;
	const signed = lines.some((line) => line.sign !== " ");
	return (
		<div className="min-w-0">
			<pre
				aria-label={label}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling block must be reachable by keyboard
				tabIndex={0}
				className="m-0 max-h-96 overflow-auto rounded-lg border border-kumo-hairline bg-kumo-tint px-2.5 py-2 font-mono text-kumo-default text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
			>
				{shown.map((line, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
						key={index}
						data-diff={
							line.sign === "+"
								? "added"
								: line.sign === "-"
									? "removed"
									: undefined
						}
						className={cn(
							"block min-h-5 w-max min-w-full",
							line.sign === "+" && "bg-kumo-success-tint",
							line.sign === "-" && "bg-kumo-danger-tint",
						)}
					>
						{signed ? `${line.sign} ` : ""}
						{line.text}
					</span>
				))}
			</pre>
			{hidden ? (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={() => setAll(true)}
				>
					Show more ({hidden} more line{hidden === 1 ? "" : "s"})
				</Button>
			) : null}
		</div>
	);
}

const plain = (text: string): Line[] =>
	text
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => ({ sign: " " as const, text: line }));

function MachineActionDetail({
	action,
	loadFull,
}: {
	action: MachineAction;
	loadFull: (callId: string) => Promise<MachineToolCallResult>;
}) {
	const [full, setFull] = useState<MachineToolCallResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const text = sanitizeUntrustedText(full?.result ?? action.text);
	const error = full
		? full.error
			? sanitizeUntrustedText(full.error)
			: null
		: action.error;
	const waiting = full
		? full.status === "pending" || full.status === "claimed"
		: action.status === "waiting";
	const cut = action.cut && !full;
	const canLoad = Boolean(action.callId) && (cut || waiting);
	return (
		<div className="flex min-w-0 flex-col gap-1.5 pt-1 pb-2 pl-7">
			{action.kind === "command" && action.target ? (
				<Text tone="mono" className="m-0 whitespace-pre-wrap break-words">
					$ {action.target}
				</Text>
			) : null}
			{action.change && (action.change.removed || action.change.added) ? (
				<Lines
					lines={machineDiffLines(action.change)}
					label={action.kind === "write" ? "File content" : "Change"}
				/>
			) : null}
			{text ? (
				<Lines
					lines={plain(text)}
					label={action.kind === "command" ? "Command output" : "Result"}
				/>
			) : null}
			{action.exitCode !== null ? (
				<Text
					as="span"
					role="label"
					tone={action.exitCode === 0 ? "secondary" : "error"}
					data-slot="machine-action-exit"
				>
					Exit code {action.exitCode}
				</Text>
			) : null}
			{error ? (
				<Text
					role="label"
					tone="error"
					className="m-0 [overflow-wrap:anywhere]"
				>
					{error}
				</Text>
			) : null}
			{waiting ? (
				<Text role="label" tone="secondary" className="m-0">
					The machine has not answered yet.
				</Text>
			) : !text && !error && !action.change ? (
				<Text role="label" tone="secondary" className="m-0">
					No result text was kept for this action.
				</Text>
			) : null}
			{cut ? (
				<Text role="label" tone="secondary" className="m-0">
					This is the start of the result.
				</Text>
			) : null}
			{canLoad ? (
				<div>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						loading={loading}
						onClick={() => {
							if (!action.callId) return;
							setLoading(true);
							setLoadFailed(false);
							loadFull(action.callId)
								.then(setFull)
								.catch(() => setLoadFailed(true))
								.finally(() => setLoading(false));
						}}
					>
						{loading
							? "Loading…"
							: waiting
								? "Check for the result"
								: "Show full result"}
					</Button>
				</div>
			) : null}
			{loadFailed ? (
				<Text role="label" tone="error" className="m-0">
					The full result could not be loaded.
				</Text>
			) : null}
		</div>
	);
}

function MachineActionRow({
	action,
	loadFull,
}: {
	action: MachineAction;
	loadFull: (callId: string) => Promise<MachineToolCallResult>;
}) {
	const [open, setOpen] = useState(false);
	const { label, icon: KindIcon } = KIND[action.kind];
	const failed =
		action.status === "failed" ||
		(action.exitCode !== null && action.exitCode !== 0);
	return (
		<li
			data-slot="machine-action"
			data-action-kind={action.kind}
			data-action-status={action.status}
			className="min-w-0"
		>
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger className="flex w-full min-w-0 flex-wrap gap-x-2 gap-y-0 px-1.5">
					<span className="flex min-w-0 flex-1 basis-40 items-center gap-2">
						<KindIcon size={15} aria-hidden className="shrink-0" />
						<Text as="span" weight="medium" className="shrink-0">
							{label}
						</Text>
						<Text
							as="span"
							tone="mono-secondary"
							truncate
							className="min-w-0 flex-1"
							title={action.target}
						>
							{action.target}
						</Text>
					</span>
					<span className="ml-auto flex min-w-0 items-center gap-2">
						{action.machine ? (
							<Text
								as="span"
								role="label"
								tone="secondary"
								truncate
								className="max-w-40"
								data-slot="machine-action-machine"
							>
								{action.machine}
							</Text>
						) : null}
						{action.status === "running" ? (
							<Loader aria-label="Running" size={14} />
						) : action.status === "waiting" ? (
							<Badge variant="outline">{STATUS_LABEL.waiting}</Badge>
						) : failed ? (
							<Badge variant="destructive">
								{action.status === "failed"
									? STATUS_LABEL.failed
									: `Exit ${action.exitCode}`}
							</Badge>
						) : (
							<Check
								size={14}
								className="shrink-0 text-kumo-success"
								aria-label={STATUS_LABEL.done}
							/>
						)}
						<CaretRight
							size={12}
							aria-hidden
							className={cn(
								"shrink-0 transition-transform motion-reduce:transition-none",
								open && "rotate-90",
							)}
						/>
					</span>
				</CollapsibleTrigger>
				<CollapsibleContent>
					{open ? (
						<MachineActionDetail action={action} loadFull={loadFull} />
					) : null}
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

/**
 * What a tedi did on a machine during one turn, in the chat: one line per
 * action with its target, the machine and how it went; opening a line shows
 * the result, an edit's change or a command's output. Several actions fold
 * into one summary line.
 */
export function MachineActivity({
	actions,
	defaultOpen = false,
	loadFull = readMachineToolCallResult,
}: {
	actions: readonly MachineAction[];
	/** Open the group from the start, as for a turn still going. */
	defaultOpen?: boolean;
	loadFull?: (callId: string) => Promise<MachineToolCallResult>;
}) {
	const [open, setOpen] = useState(defaultOpen);
	if (actions.length === 0) return null;
	const rows = (
		<ul
			aria-label="Actions on the machine"
			className="m-0 flex min-w-0 list-none flex-col p-0"
		>
			{actions.map((action) => (
				<MachineActionRow
					key={action.key}
					action={action}
					loadFull={loadFull}
				/>
			))}
		</ul>
	);
	const running = actions.some((action) => action.status === "running");
	const failed = actions.filter((action) => action.status === "failed").length;
	const waiting = actions.filter(
		(action) => action.status === "waiting",
	).length;
	const machines = [...new Set(actions.map((action) => action.machine))];
	return (
		<li data-slot="machine-activity" className="flex w-full min-w-0">
			<div className="min-w-0 max-w-[860px] flex-1">
				{actions.length === 1 ? (
					rows
				) : (
					<Collapsible open={open} onOpenChange={setOpen}>
						<CollapsibleTrigger className="flex w-full min-w-0 flex-wrap gap-x-2 gap-y-0 px-1.5">
							<span className="flex min-w-0 flex-1 basis-full sm:basis-40 items-center gap-2">
								{running ? (
									<Loader aria-label="Working on the machine" size={15} />
								) : (
									<Desktop size={15} aria-hidden className="shrink-0" />
								)}
								<Text
									as="span"
									className="min-w-0 flex-1 [overflow-wrap:anywhere]"
								>
									{summarizeMachineActions(actions)}
								</Text>
							</span>
							<span className="ml-auto flex min-w-0 items-center gap-2">
								{machines.length === 1 && machines[0] ? (
									<Text
										as="span"
										role="label"
										tone="secondary"
										truncate
										className="max-w-40"
									>
										{machines[0]}
									</Text>
								) : null}
								{failed ? (
									<Badge variant="destructive">{failed} failed</Badge>
								) : null}
								{waiting ? (
									<Badge variant="outline">{waiting} waiting</Badge>
								) : null}
								<CaretRight
									size={12}
									aria-hidden
									className={cn(
										"shrink-0 transition-transform motion-reduce:transition-none",
										open && "rotate-90",
									)}
								/>
							</span>
						</CollapsibleTrigger>
						<CollapsibleContent className="ml-3 border-kumo-hairline border-l pl-1.5">
							{rows}
						</CollapsibleContent>
					</Collapsible>
				)}
			</div>
		</li>
	);
}
