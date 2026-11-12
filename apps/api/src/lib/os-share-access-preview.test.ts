import { describe, expect, it } from "vite-plus/test";
import { shareAccessChange } from "./os-share-access-preview";

const nobody = { people: 0, organization: false, anyoneWithLink: false };
const outsider = { id: "a", inOrganization: false, inWorkspace: false };
const colleague = { id: "b", inOrganization: true, inWorkspace: false };
const teammate = { id: "c", inOrganization: true, inWorkspace: true };
const invitees = [outsider, colleague, teammate];
const open = (access: "anyone_with_link" | "organization" | "invited") => ({
	open: true,
	access,
});
const off = (access: "anyone_with_link" | "organization" | "invited") => ({
	open: false,
	access,
});

describe("shareAccessChange", () => {
	it("turning a link off loses exactly who it reached", () => {
		expect(
			shareAccessChange({
				before: open("anyone_with_link"),
				after: off("anyone_with_link"),
				invitees,
			}),
		).toEqual({
			loses: { ...nobody, anyoneWithLink: true },
			gains: nobody,
			remaining: nobody,
			keepThroughWorkspace: 0,
		});
		expect(
			shareAccessChange({
				before: open("organization"),
				after: off("organization"),
				invitees,
			}).loses,
		).toEqual({ ...nobody, organization: true });
		// Invited people are counted; one of them is in the workspace anyway.
		expect(
			shareAccessChange({
				before: open("invited"),
				after: off("invited"),
				invitees,
			}),
		).toEqual({
			loses: { ...nobody, people: 2 },
			gains: nobody,
			remaining: nobody,
			keepThroughWorkspace: 1,
		});
	});

	it("turning a link back on gains exactly who it reaches, and loses nobody", () => {
		expect(
			shareAccessChange({
				before: off("invited"),
				after: open("invited"),
				invitees,
			}),
		).toEqual({
			loses: nobody,
			gains: { ...nobody, people: 2 },
			remaining: { ...nobody, people: 3 },
			keepThroughWorkspace: 0,
		});
	});

	it("narrowing the audience names the group that is cut off", () => {
		expect(
			shareAccessChange({
				before: open("anyone_with_link"),
				after: open("organization"),
				invitees,
			}),
		).toMatchObject({
			loses: { ...nobody, anyoneWithLink: true },
			gains: nobody,
			remaining: { ...nobody, organization: true },
		});
		expect(
			shareAccessChange({
				before: open("anyone_with_link"),
				after: open("invited"),
				invitees,
			}),
		).toMatchObject({
			loses: { ...nobody, anyoneWithLink: true },
			gains: nobody,
			remaining: { ...nobody, people: 3 },
		});
		expect(
			shareAccessChange({
				before: open("organization"),
				after: open("invited"),
				invitees,
			}),
		).toMatchObject({
			loses: { ...nobody, organization: true },
			// The outsider on the invite list could not open it before.
			gains: { ...nobody, people: 1 },
		});
	});

	it("moving from invited people to the organization drops only the outsiders", () => {
		expect(
			shareAccessChange({
				before: open("invited"),
				after: open("organization"),
				invitees,
			}),
		).toEqual({
			loses: { ...nobody, people: 1 },
			gains: { ...nobody, organization: true },
			remaining: { ...nobody, organization: true },
			keepThroughWorkspace: 0,
		});
	});

	it("widening loses nobody", () => {
		for (const before of ["organization", "invited"] as const)
			expect(
				shareAccessChange({
					before: open(before),
					after: open("anyone_with_link"),
					invitees,
				}),
			).toMatchObject({
				loses: nobody,
				gains: { ...nobody, anyoneWithLink: true },
				keepThroughWorkspace: 0,
			});
	});

	it("removing one invited person loses that person, unless the workspace still lets them in", () => {
		expect(
			shareAccessChange({
				before: open("invited"),
				after: open("invited"),
				invitees,
				removedInviteeId: "a",
			}),
		).toEqual({
			loses: { ...nobody, people: 1 },
			gains: nobody,
			remaining: { ...nobody, people: 2 },
			keepThroughWorkspace: 0,
		});
		expect(
			shareAccessChange({
				before: open("invited"),
				after: open("invited"),
				invitees,
				removedInviteeId: "c",
			}),
		).toMatchObject({ loses: nobody, keepThroughWorkspace: 1 });
		// A link that reaches people as a group does not depend on the list.
		expect(
			shareAccessChange({
				before: open("anyone_with_link"),
				after: open("anyone_with_link"),
				invitees,
				removedInviteeId: "a",
			}),
		).toMatchObject({ loses: nobody, gains: nobody });
	});

	it("changes nothing for a link that is already off", () => {
		expect(
			shareAccessChange({
				before: off("anyone_with_link"),
				after: off("invited"),
				invitees,
			}),
		).toEqual({
			loses: nobody,
			gains: nobody,
			remaining: nobody,
			keepThroughWorkspace: 0,
		});
	});
});
