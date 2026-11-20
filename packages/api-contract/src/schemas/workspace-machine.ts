/**
 * What the workspace store sends when its agent uses a machine for the person
 * who sent a chat turn. The store only names who is acting; the API checks
 * their membership, their workspace access and every machine rule again when
 * the call is made.
 */

import * as z from "zod";
import {
	type Machine,
	type MachineToolCall,
	type MachineToolCallStatus,
	RequestMachineToolCallInputSchema,
} from "./machines";

const WorkspaceMachineRequestBase = {
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1),
	/** The signed-in person who sent the turn. */
	userId: z.string().min(1),
	/** The tedi the person addressed as the turn's guest, when there is one. */
	tediId: z.string().min(1).optional(),
};

export const WorkspaceMachineInputSchema = z.discriminatedUnion("op", [
	z.strictObject({ ...WorkspaceMachineRequestBase, op: z.literal("list") }),
	z.strictObject({
		...WorkspaceMachineRequestBase,
		op: z.literal("call"),
		call: RequestMachineToolCallInputSchema,
	}),
	z.strictObject({
		...WorkspaceMachineRequestBase,
		op: z.literal("read"),
		callId: z.uuid(),
	}),
]);

export type WorkspaceMachineInput = z.input<typeof WorkspaceMachineInputSchema>;

export type WorkspaceMachineResult =
	| { status: "machines"; machines: Machine[] }
	| { status: "queued"; callId: string; callStatus: MachineToolCallStatus }
	| { status: "call"; call: MachineToolCall }
	| { status: "refused"; message: string };
