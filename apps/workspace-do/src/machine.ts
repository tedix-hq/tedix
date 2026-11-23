import {
	MACHINE_FILE_ANSWER_WINDOW_MS,
	MACHINE_TOOL_CALL_CLAIM_WINDOW_MS,
	MACHINE_TOOL_NAMES,
	type MachineToolCall,
	parseMachineToolInput,
} from "@tedix/api-contract/schemas/machines";
import {
	MACHINE_REQUEST_BUSY,
	type WorkspaceMachineInput,
	type WorkspaceMachineResult,
} from "@tedix/api-contract/schemas/workspace-machine";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { WorkspaceScope } from "./env";

export const MACHINE_UNAVAILABLE =
	"A machine can be used only in a turn that a signed-in person sent themself. It is not available to scheduled turns or to turns a tedi or an app started.";

/** How long a call waits for the machine before it hands back a call id. */
const WAIT_MS = 20_000;
const POLL_MS = 1_500;
/** How long starting a run waits for a runner to take the wake. */
const WAKE_WAIT_MS = 5_000;

export interface MachineService {
	useMachine(input: WorkspaceMachineInput): Promise<WorkspaceMachineResult>;
}

/**
 * A machine of the organization, used for the person who sent the turn. This
 * only names who is acting and carries the call: the API decides, when the
 * call is made, whether that person may use a machine from this workspace and
 * whether the machine accepts the tool. A refusal comes back as its reason.
 */
export function workspaceMachine(deps: {
	scope: WorkspaceScope;
	/** The signed-in person who sent the turn. */
	userId: string;
	/** The tedi the person addressed; its calls are queued under the tedi. */
	tediId?: string | null;
	api: MachineService;
	wait?: (ms: number) => Promise<void>;
	/** Keep a slow read attached to the turn after its sandbox code finishes. */
	followFile?: (
		machine: string,
		read: (active: () => boolean) => Promise<string>,
	) => void;
}) {
	const wait =
		deps.wait ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const acting = {
		...deps.scope,
		userId: deps.userId,
		...(deps.tediId ? { tediId: deps.tediId } : {}),
	};
	const fenced = (text: string | undefined) =>
		text === undefined ? undefined : wrapUntrustedInput(text, "machine_tool");
	/** What the agent sees for a call: its result once it ended, else its id. */
	const shown = (call: MachineToolCall) =>
		call.status === "pending" || call.status === "claimed"
			? {
					callId: call.callId,
					machine: call.machine,
					tool: call.tool,
					status: call.status,
					next: "The machine has not answered yet. Read the result later with env.machine.read({ callId }).",
				}
			: {
					callId: call.callId,
					machine: call.machine,
					tool: call.tool,
					status: call.status,
					...(call.result === undefined ? {} : { result: fenced(call.result) }),
					...(call.status === "expired"
						? { error: "No runner on the machine picked the call up in time" }
						: call.error === undefined
							? {}
							: { error: fenced(call.error) }),
				};
	async function readCall(callId: unknown) {
		if (typeof callId !== "string" || !callId)
			throw new Error("Name the call by its callId.");
		const result = await deps.api.useMachine({ ...acting, op: "read", callId });
		if (result.status === "call") return result.call;
		throw new Error(
			result.status === "refused"
				? result.message
				: "The machine call could not be read.",
		);
	}
	async function list() {
		const result = await deps.api.useMachine({ ...acting, op: "list" });
		if (result.status === "machines")
			return result.machines.map(({ machineName, online, machineTools }) => ({
				machine: machineName,
				online,
				tools: machineTools,
			}));
		throw new Error(
			result.status === "refused"
				? result.message
				: "The machines could not be listed.",
		);
	}
	return {
		list,
		/** True when the sender's own runner reports from this machine. */
		async isOwn(machine: unknown) {
			if (typeof machine !== "string") return false;
			const result = await deps.api.useMachine({ ...acting, op: "list" });
			const wanted = machine.toLowerCase();
			return (
				result.status === "machines" &&
				result.machines.some(
					(candidate) =>
						candidate.machineName.toLowerCase() === wanted &&
						candidate.ownedBySender === true,
				)
			);
		},
		/**
		 * Throws the reason a call cannot run: an unknown tool, an input the
		 * tool does not take, or a machine that is unknown, offline or does not
		 * accept the tool. Run before a person is asked to approve the call, so
		 * nobody approves one that would fail and the agent can correct it.
		 */
		async assertCanRun(input: {
			machine?: unknown;
			tool?: unknown;
			input?: unknown;
		}) {
			if (typeof input?.machine !== "string" || typeof input.tool !== "string")
				throw new Error("Supply a machine name, a tool name and its input.");
			const tool = MACHINE_TOOL_NAMES.find((name) => name === input.tool);
			if (!tool)
				throw new Error(
					`There is no machine tool ${input.tool}. The tools are ${MACHINE_TOOL_NAMES.join(", ")}.`,
				);
			const checked = parseMachineToolInput(tool, input.input);
			if (!checked.ok) throw new Error(`${tool}: ${checked.message}`);
			const wanted = input.machine.toLowerCase();
			const machine = (await list()).find(
				(candidate) => candidate.machine.toLowerCase() === wanted,
			);
			if (!machine)
				throw new Error(
					`No machine named "${input.machine}" reports to this organization.`,
				);
			if (!machine.tools.includes(tool))
				throw new Error(`${machine.machine} does not accept ${tool}.`);
			if (!machine.online) throw new Error(`${machine.machine} is offline.`);
		},
		async call(input: { machine?: unknown; tool?: unknown; input?: unknown }) {
			if (typeof input?.machine !== "string" || typeof input.tool !== "string")
				throw new Error("Supply a machine name, a tool name and its input.");
			const queued = await deps.api.useMachine({
				...acting,
				op: "call",
				call: {
					machine: input.machine,
					tool: input.tool,
					input: input.input ?? {},
				} as Extract<WorkspaceMachineInput, { op: "call" }>["call"],
			});
			if (queued.status !== "queued")
				throw new Error(
					queued.status === "refused"
						? queued.message
						: "The machine call could not be queued.",
				);
			const readFile = input.tool === "read_file" && deps.followFile;
			if (readFile) {
				const pending = async () => {
					try {
						return await readCall(queued.callId);
					} catch (error) {
						if (
							error instanceof Error &&
							error.message === MACHINE_REQUEST_BUSY
						)
							return null;
						throw error;
					}
				};
				const deadline =
					Date.now() +
					MACHINE_TOOL_CALL_CLAIM_WINDOW_MS +
					MACHINE_FILE_ANSWER_WINDOW_MS;
				await wait(POLL_MS);
				const first = await pending();
				if (first && first.status !== "pending" && first.status !== "claimed")
					return shown(first);
				readFile(input.machine, async (active) => {
					while (active() && Date.now() < deadline) {
						const answer = await pending();
						if (
							answer &&
							answer.status !== "pending" &&
							answer.status !== "claimed"
						) {
							const result = shown(answer);
							if ("error" in result && result.error)
								throw new Error(result.error);
							return JSON.stringify(result);
						}
						await wait(5_000);
					}
					throw new Error(
						"The computer has not returned the file. Check for a folder access request on the Mac.",
					);
				});
				return {
					callId: queued.callId,
					machine: input.machine,
					tool: input.tool,
					status: first?.status ?? queued.callStatus,
					next: "The file result will follow in this turn.",
				};
			}
			const deadline = Date.now() + WAIT_MS;
			for (;;) {
				await wait(POLL_MS);
				const current = await readCall(queued.callId);
				if (
					(current.status !== "pending" && current.status !== "claimed") ||
					Date.now() >= deadline
				)
					return shown(current);
			}
		},
		read: async (input: { callId?: unknown }) =>
			shown(await readCall(input?.callId)),
		/**
		 * Tells a connected runner about one accepted task so it starts at
		 * once. Never throws: a machine that is refused, missing or slow
		 * leaves the task for the runner's normal pickup.
		 */
		async wakeRunner(input: {
			workItemId: string;
			projectId: string;
			executor: string;
		}) {
			const deadline = Date.now() + WAKE_WAIT_MS;
			try {
				const listed = await deps.api.useMachine({ ...acting, op: "list" });
				if (listed.status !== "machines") return;
				const eligible = listed.machines.filter(
					(machine) =>
						machine.online &&
						machine.machineTools.includes("dispatch_work_item"),
				);
				const target =
					eligible.find((machine) =>
						machine.executors.includes(input.executor),
					) ??
					eligible.find((machine) => machine.executors.includes("any-local")) ??
					(input.executor === "any-local"
						? eligible.find((machine) =>
								machine.executors.some((executor) =>
									["codex", "claude-code", "opencode", "devin"].includes(
										executor,
									),
								),
							)
						: undefined);
				if (!target) return;
				const queued = await deps.api.useMachine({
					...acting,
					op: "call",
					call: {
						machine: target.machineName,
						tool: "dispatch_work_item",
						input,
					},
				});
				if (queued.status !== "queued") return;
				while (Date.now() < deadline) {
					const { status } = await readCall(queued.callId);
					if (status !== "pending" && status !== "claimed") return;
					await wait(500);
				}
			} catch {
				// The task was accepted even if the wake could not be delivered.
			}
		},
	};
}
