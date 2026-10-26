import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	PersonalAgentEnrollmentSchema,
	PersonalAgentImageUrlSchema,
	PersonalAgentValueSchema,
} from "../schemas/personal-agent-inbound";

export const personalAgentInboundContract = oc.errors(baseErrors).router({
	configureDelivery: oc
		.input(
			z.strictObject({
				id: z.uuid(),
				email: z
					.strictObject({ memberId: z.uuid(), senderAddressId: z.uuid() })
					.nullable(),
			}),
		)
		.output(PersonalAgentEnrollmentSchema),
	/** The represented person sets the logo shown beside their agent's findings. */
	configureIdentity: oc
		.input(
			z.strictObject({
				id: z.uuid(),
				imageUrl: PersonalAgentImageUrlSchema.nullable(),
			}),
		)
		.output(PersonalAgentEnrollmentSchema),
	value: oc.input(z.strictObject({})).output(z.array(PersonalAgentValueSchema)),
	enroll: oc
		.input(
			z.strictObject({
				sourceAgentName: z.string().trim().min(1).max(100),
				imageUrl: PersonalAgentImageUrlSchema.optional(),
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
