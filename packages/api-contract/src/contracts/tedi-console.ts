import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
const target = z.object({ tediId: z.string().uuid() });
const tediConsoleGrantSchema = z.object({
	enabled: z.boolean(),
	workspaceIds: z.array(z.string().uuid()),
});
export const tediConsoleContract = oc
	.route({ tags: ["internal"] })
	.errors(baseErrors)
	.router({
		getGrant: oc
			.route({ tags: ["internal"] })
			.input(target)
			.output(tediConsoleGrantSchema),
		setGrant: oc
			.route({ tags: ["internal"] })
			.input(target.extend(tediConsoleGrantSchema.shape).strict())
			.output(tediConsoleGrantSchema),
		createSession: oc
			.route({ tags: ["internal"] })
			.input(z.object({}).strict())
			.output(z.object({ sessionToken: z.string(), expiresAt: z.number() })),
		read: oc
			.route({ tags: ["internal"] })
			.input(z.object({ workspaceId: z.string().uuid().optional() }).strict())
			.output(
				z.object({
					tediId: z.string(),
					name: z.string(),
					readOnly: z.literal(true),
					workspaces: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							description: z.string().nullable(),
						}),
					),
					outputs: z.array(
						z.object({ id: z.string(), title: z.string(), kind: z.string() }),
					),
				}),
			),
	});
