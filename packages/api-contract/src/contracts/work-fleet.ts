import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { WorkFleetControlTowerSchema } from "../schemas/work-fleet";

export const workFleetContract = oc
	.route({ tags: ["work-fleet"], prefix: "/work-fleet" })
	.errors(baseErrors)
	.router({
		getControlTower: oc
			.route({
				method: "GET",
				path: "/control-tower",
				summary: "Get Work fleet control tower",
			})
			.input(z.strictObject({}))
			.output(WorkFleetControlTowerSchema),
	});

export type WorkFleetContract = typeof workFleetContract;
