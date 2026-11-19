import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ClaimMachineToolCallsInputSchema,
	ClaimMachineToolCallsResultSchema,
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
					"List the machines whose runners report to this organization, with the agents each one runs, the read-only tools it accepts and whether it is online.",
			})
			.output(ListMachinesResultSchema),
		requestToolCall: oc
			.route({
				method: "POST",
				path: "/tool-calls",
				summary: "Queue a read-only tool call for a machine",
				description:
					"Queue one read-only tool call for a named machine: read a file, search code, list or read commits, read CI runs or a CI job log, or read the state of its runners. Refused when the machine is unknown, offline or does not accept the tool. Read the result with read_machine_tool_call.",
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
