import { z } from "zod";
import { JsonValueSchema } from "./common";
import {
	AppRuntimeMethodSchema,
	type AppRuntimePublicOperationsSchema,
} from "./os-app-runtime";

export const ListAppOperationsSchema = z.strictObject({
	appId: z.string().uuid(),
});
export type ListAppOperations = z.infer<typeof ListAppOperationsSchema>;

export const RunAppOperationSchema = ListAppOperationsSchema.extend({
	name: AppRuntimeMethodSchema,
	input: z.record(z.string(), JsonValueSchema).default({}),
});
export type RunAppOperation = z.input<typeof RunAppOperationSchema>;

/** Only the workspace store supplies the sender and turn, never sandbox code. */
const WorkspaceSender = {
	organizationId: z.string().min(1),
	workspaceId: z.string().uuid(),
	turnId: z.string().uuid(),
	userId: z.string().min(1),
};

export const WorkspaceListAppOperationsSchema =
	ListAppOperationsSchema.extend(WorkspaceSender);
export type WorkspaceListAppOperations = z.infer<
	typeof WorkspaceListAppOperationsSchema
>;

export const WorkspaceRunAppOperationSchema =
	RunAppOperationSchema.extend(WorkspaceSender);
export type WorkspaceRunAppOperation = z.input<
	typeof WorkspaceRunAppOperationSchema
>;

export interface AppOperations {
	appId: string;
	revisionId: string;
	operations: z.infer<typeof AppRuntimePublicOperationsSchema>;
}
