import { expect, test } from "bun:test";
import {
	validateQuarantine,
	quarantineFailure,
} from "./browser-quarantine.mjs";
import never from "./never-quarantine.json";

const entry = {
	testId: "apps/os/browser-tests/example.spec.ts::phone light",
	ownerWorkItem: "00000000-0000-4000-8000-000000000001",
	createdAt: "2026-10-22T12:00:00Z",
	expiresAt: "2026-10-29T00:00:00Z",
	failure: { name: "TimeoutError", message: "observed timeout" },
	evidence: {
		sha: "a".repeat(40),
		failedAt: "2026-10-22T10:00:00Z",
		passedAt: "2026-10-22T11:00:00Z",
		failedJob: "https://github.com/tedix-hq/tedix/actions/runs/1/job/2",
		passedJob: "https://github.com/tedix-hq/tedix/actions/runs/3/job/4",
	},
};
const now = Date.parse("2026-10-22T14:00:00Z");
test("rejects expired, overlong, ownerless, duplicate and unsupported quarantine", () => {
	expect(validateQuarantine([entry], never, now)).toEqual([entry]);
	for (const invalid of [
		{ ...entry, expiresAt: "2026-10-22T13:00:00Z" },
		{ ...entry, expiresAt: "2026-11-06T00:00:00Z" },
		{ ...entry, ownerWorkItem: "" },
		{ ...entry, testId: "apps/os/browser-tests/example.spec.ts::*" },
		{
			...entry,
			evidence: { ...entry.evidence, passedAt: entry.evidence.failedAt },
		},
		{
			...entry,
			evidence: { ...entry.evidence, failedAt: "2026-10-19T10:00:00Z" },
		},
		{ ...entry, evidence: { ...entry.evidence, sha: "main" } },
	])
		expect(() => validateQuarantine([invalid], never, now)).toThrow();
	expect(() => validateQuarantine([entry, entry], never, now)).toThrow(
		"Duplicate",
	);
});
test("security, auth, billing, migration and mixed critical suites can never be quarantined", () => {
	for (const name of [
		"security",
		"oauth",
		"billing",
		"migration",
		"permissions",
		"tenant",
		"credentials",
		"payment",
		"focus-clip",
		"shell",
		"topbar",
	])
		expect(() =>
			validateQuarantine(
				[
					{
						...entry,
						testId: `apps/os/browser-tests/${name}.spec.ts::phone light`,
					},
				],
				never,
				now,
			),
		).toThrow("Never quarantine");
});
test("a quarantine cannot tolerate another case or an unobserved failure", () => {
	expect(
		quarantineFailure(entry.testId, new Error("different regression"), [entry]),
	).toBe(false);
	expect(
		quarantineFailure(
			"another test",
			{ name: "TimeoutError", message: "observed timeout" },
			[entry],
		),
	).toBe(false);
	expect(
		quarantineFailure(
			entry.testId,
			{ name: "TimeoutError", message: "observed timeout" },
			[entry],
		),
	).toBe(true);
});
