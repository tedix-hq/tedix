import { expect, test } from "vite-plus/test";
import { guestMayUseMemory } from "./guest-memory";

const personal = { id: "tedi-1", scope: "personal", ownerUserId: "ana" };
const own = { visibility: "private", ownerUserId: "ana" };

test("a personal tedi brings its memory only where nobody but its owner can read", () => {
	const base = { tedi: personal, workspace: own, edges: [], links: [] };
	expect(guestMayUseMemory(base)).toBe(true);
	expect(
		guestMayUseMemory({
			...base,
			edges: [{ targetUserId: "ana" }, { targetUserId: "tedi-1" }],
		}),
	).toBe(true);
	// Someone else added, an open link, a shared workspace, another owner.
	expect(guestMayUseMemory({ ...base, edges: [{ targetUserId: "ben" }] })).toBe(
		false,
	);
	expect(guestMayUseMemory({ ...base, links: [{ revokedAt: null }] })).toBe(
		false,
	);
	expect(
		guestMayUseMemory({
			...base,
			workspace: { visibility: "org", ownerUserId: "ana" },
		}),
	).toBe(false);
	expect(
		guestMayUseMemory({
			...base,
			workspace: { visibility: "private", ownerUserId: "ben" },
		}),
	).toBe(false);
	// An organization tedi's memory is the organization's.
	expect(
		guestMayUseMemory({
			...base,
			tedi: { id: "tedi-2", scope: "organization", ownerUserId: null },
			workspace: { visibility: "org", ownerUserId: null },
		}),
	).toBe(true);
});
