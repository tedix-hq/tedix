import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	CreatePersonalResourceDelegationSchema,
	PersonalResourceDelegationSchema,
} from "../schemas/personal-resource-delegations";
export const personalResourceDelegationsContract = oc
	.route({
		tags: ["personal-resource-delegations"],
		prefix: "/personal-resource-delegations",
	})
	.errors(baseErrors)
	.router({
		create: oc
			.input(CreatePersonalResourceDelegationSchema)
			.output(PersonalResourceDelegationSchema),
		list: oc
			.input(
				z
					.object({ limit: z.number().int().min(1).max(100).optional() })
					.strict(),
			)
			.output(z.array(PersonalResourceDelegationSchema)),
		revoke: oc
			.input(z.object({ id: z.uuid() }).strict())
			.output(PersonalResourceDelegationSchema),
	});
