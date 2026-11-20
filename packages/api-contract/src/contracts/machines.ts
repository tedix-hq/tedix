import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ClaimMachineToolCallsInputSchema,
	ClaimMachineToolCallsResultSchema,
	ListMachineToolCallsInputSchema,
	ListMachineToolCallsResultSchema,
	ListMachinesResultSchema,
	MachineToolCallSchema,
	ReadMachineToolCallInputSchema,
	RequestMachineToolCallInputSchema,
	RequestMachineToolCallResultSchema,
} from "../schemas/machines";

export const machinesContract = oc
	.route({ tags: ["machines"], prefix: "/machines" })
	.errors(baseErrors)
	.router({
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List machines",
				description:
					"List the machines whose runners report to this organization, with the agents each one runs, the tools it accepts and whether it is online.",
			})
			.output(ListMachinesResultSchema),
		requestToolCall: oc
			.route({
				method: "POST",
				path: "/tool-calls",
				summary: "Queue a tool call for a machine",
				description:
					"Queue one tool call for a named machine: read a file, search code, list or read commits, read CI runs or a CI job log, read the state of its runners, or wake a runner to check one Work Item. A machine whose owner switched the write tools on also accepts: open or close a workspace (its own checkout of the repository), write or edit a file in it, and run a command in it. Refused when the machine is unknown, offline or does not accept the tool. Read the result with read_machine_tool_call.",
			})
			.input(RequestMachineToolCallInputSchema)
			.output(RequestMachineToolCallResultSchema),
		readToolCall: oc
			.route({
				method: "GET",
				path: "/tool-calls/{callId}",
				summary: "Read a machine tool call",
				description:
					"Read the state and result of a tool call queued for a machine. Only the one who queued it, or an organization admin, may read it.",
			})
			.input(ReadMachineToolCallInputSchema)
			.output(MachineToolCallSchema),
		listToolCalls: oc
			.route({
				method: "GET",
				path: "/tool-calls",
				summary: "List machine tool calls with their input",
				description:
					"List the tool calls that members and agents asked this organization's machines to make, oldest first by default, with each call's input: the command, file path or file content sent to the machine. By default it lists only calls that change a workspace or run a command, made in the last 24 hours; a range may cover at most 7 days. The machine's answer is never listed, only its length. Follow nextCursor with the same filters to read the next page. To check a call against the change record, hash its input: it equals the argsHash of the record whose traceId is the call id. Only an active owner or admin of the organization can call it.",
			})
			.input(ListMachineToolCallsInputSchema)
			.output(ListMachineToolCallsResultSchema),
		claimToolCalls: oc
			.route({
				method: "POST",
				path: "/tool-calls/claim",
				summary: "Claim tool calls for a machine",
				description:
					"Called by the runner on a machine. Stores the results of calls it claimed earlier, then hands over the next waiting calls for that machine, oldest first.",
			})
			.input(ClaimMachineToolCallsInputSchema)
			.output(ClaimMachineToolCallsResultSchema),
	});

export type MachinesContract = typeof machinesContract;
