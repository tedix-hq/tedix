import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	PoppyAgentGetInputSchema,
	PoppyAgentIdentityViewSchema,
	PoppyAgentSetEnabledInputSchema,
} from "../schemas/poppy-agent";

export const poppyAgentContract = oc
	.route({ tags: ["poppy-agent"], prefix: "/poppy-agent" })
	.errors(baseErrors)
	.router({
		get: oc
			.route({
				method: "POST",
				path: "/get",
				summary: "Read a tedi's Poppy personal-agent identity",
				description:
					"Returns the public identity URLs and enabled state for one tedi. Key material is never returned.",
			})
			.input(PoppyAgentGetInputSchema)
			.output(PoppyAgentIdentityViewSchema),
		setEnabled: oc
			.route({
				method: "POST",
				path: "/set-enabled",
				summary: "Turn a tedi's Poppy personal-agent identity on or off",
				description:
					"Enabling generates an ES256 signing key, stores it encrypted in the tedi's secrets, and publishes client metadata plus JWKS at the tedi's stable identity URL. Disabling deletes the key and takes the documents offline.",
			})
			.input(PoppyAgentSetEnabledInputSchema)
			.output(PoppyAgentIdentityViewSchema),
	});

export type PoppyAgentContract = typeof poppyAgentContract;
