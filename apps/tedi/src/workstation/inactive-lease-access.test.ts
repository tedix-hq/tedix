import { expect, it } from "vite-plus/test";
import { canAccessInactiveWorkstation } from "./inactive-lease-access";

const failedOwner = {
	path: "/api/admin/workstation/release",
	leaseStatus: "blocked",
	participantRole: "lead",
	participantStatus: "left",
	preserveChanges: true,
};

it("lets the departed owner reach preservation-aware cleanup of a failed lease", () => {
	expect(canAccessInactiveWorkstation(failedOwner)).toBe(true);
});

it("allows passive status only for the departed owner of a failed lease", () => {
	const status = {
		...failedOwner,
		path: "/api/admin/workstation/status",
		preserveChanges: false,
	};
	expect(canAccessInactiveWorkstation(status)).toBe(true);
	for (const override of [
		{ participantStatus: "removed" },
		{ participantRole: "collaborator" },
		{ leaseStatus: "active" },
	])
		expect(canAccessInactiveWorkstation({ ...status, ...override })).toBe(
			false,
		);
});

it("does not grant command, file, wake or provisioning access", () => {
	for (const action of [
		"exec",
		"files",
		"wake",
		"provision",
		"process/start",
		"process/status",
	])
		expect(
			canAccessInactiveWorkstation({
				...failedOwner,
				path: `/api/admin/workstation/${action}`,
			}),
		).toBe(false);
});

it("keeps removed participants, non-owners and unpreserved release denied", () => {
	expect(
		canAccessInactiveWorkstation({
			...failedOwner,
			participantStatus: "removed",
		}),
	).toBe(false);
	expect(
		canAccessInactiveWorkstation({
			...failedOwner,
			participantRole: "collaborator",
		}),
	).toBe(false);
	expect(
		canAccessInactiveWorkstation({ ...failedOwner, preserveChanges: false }),
	).toBe(false);
	expect(
		canAccessInactiveWorkstation({ ...failedOwner, leaseStatus: "ready" }),
	).toBe(false);
});

it("retains released execution receipts and idempotent owner cleanup", () => {
	expect(
		canAccessInactiveWorkstation({
			...failedOwner,
			leaseStatus: "released",
			preserveChanges: false,
		}),
	).toBe(true);
	expect(
		canAccessInactiveWorkstation({
			...failedOwner,
			leaseStatus: "released",
			path: "/api/admin/workstation/process/status",
		}),
	).toBe(true);
});
