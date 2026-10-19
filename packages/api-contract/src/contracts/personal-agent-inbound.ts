import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { PersonalAgentEnrollmentSchema } from "../schemas/personal-agent-inbound";

export const personalAgentInboundContract = oc.errors(baseErrors).router({
	enroll: oc
		.input(
			z.strictObject({
				sourceAgentName: z.string().trim().min(1).max(100),
				projectId: z.uuid(),
			}),
		)
		.output(
			z.strictObject({
				enrollment: PersonalAgentEnrollmentSchema,
				token: z.string(),
			}),
		),
	list: oc
		.input(z.strictObject({}))
		.output(z.array(PersonalAgentEnrollmentSchema)),
	revoke: oc
		.input(z.strictObject({ id: z.uuid() }))
		.output(z.strictObject({ revoked: z.literal(true) })),
});
