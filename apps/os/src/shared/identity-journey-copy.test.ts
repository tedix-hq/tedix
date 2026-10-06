import { describe, expect, it } from "vite-plus/test";
import { IDENTITY_JOURNEY_COPY } from "./identity-journey-copy";

describe("identity journey copy", () => {
	it("keeps one continuation message for every login surface", () => {
		expect(IDENTITY_JOURNEY_COPY.errors.continuation).toBe(
			"We could not finish signing you in. Try the sign-in again.",
		);
		expect(IDENTITY_JOURNEY_COPY.errors.invitedIdentity).toContain(
			"invited identity",
		);
	});

	it("distinguishes workspace selection from the grant decision", () => {
		expect(IDENTITY_JOURNEY_COPY.workspaceSelection).toMatchObject({
			title: "Choose a workspace",
			continueLabel: "Continue →",
			preparingLabel: "Preparing consent…",
		});
		expect(IDENTITY_JOURNEY_COPY.workspaceSelection.footnote).toContain(
			"does not grant access",
		);
		expect(IDENTITY_JOURNEY_COPY.permissionReview.title).toBe(
			"Review requested access",
		);
	});

	it("uses the same capability count language for every inbound app state", () => {
		expect(IDENTITY_JOURNEY_COPY.permissionReview.description(20)).toBe(
			"This client is requesting 20 specific Tedix capabilities. Expand a group to inspect every permission.",
		);
	});
});
