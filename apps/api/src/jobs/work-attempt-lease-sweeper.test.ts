import { expect, it } from "vite-plus/test";
import { staleDelegationSweepDue } from "./work-attempt-lease-sweeper";

it("runs the stale delegation sweep on the first tick of each hour only", () => {
	const at = (time: string) => Date.parse(`2026-11-12T${time}Z`);
	expect(staleDelegationSweepDue(at("09:00:00"))).toBe(true);
	expect(staleDelegationSweepDue(at("09:01:59"))).toBe(true);
	expect(staleDelegationSweepDue(at("09:02:00"))).toBe(false);
	expect(staleDelegationSweepDue(at("09:58:00"))).toBe(false);
});
