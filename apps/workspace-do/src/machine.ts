import type { MachineToolCall } from "@tedix/api-contract/schemas/machines";
import type {
	WorkspaceMachineInput,
	WorkspaceMachineResult,
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
	return {
		async list() {
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
					eligible.find((machine) => machine.executors.includes("any-local"));
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
