import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import { WorkMapReadInputSchema, WorkMapSchema } from "../schemas/work-map";

export const workMapContract = oc
	.route({ tags: ["work-map"], prefix: "/work-map" })
	.errors(baseErrors)
	.router({
		read: oc
			.route({
				method: "GET",
				path: "/read",
				summary:
					"Read live Work as one map: purpose tree with epic progress, runner and supervisor lanes, and work that is not moving with its blocker and who must act",
			})
			.input(WorkMapReadInputSchema)
			.output(WorkMapSchema),
	});

export type WorkMapContract = typeof workMapContract;
