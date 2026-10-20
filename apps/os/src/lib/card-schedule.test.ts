import { expect, it } from "vite-plus/test";
import { cardIsDue } from "@tedix/api-contract/utils/card-schedule";

it.each(["scheduledAt", "scheduled_for", "remindAt", "remind_at"])(
	"holds future %s regardless of card kind",
	(field) => {
		for (const kind of ["question", "coordination", "approval", "outbound"]) {
			const card = { kind, [field]: "2026-10-28T08:00:00Z" };
			expect(
				cardIsDue(card, new Date("2026-10-18T12:00:00Z"), "Europe/Berlin"),
			).toBe(false);
			expect(
				cardIsDue(card, new Date("2026-10-27T23:00:00Z"), "Europe/Berlin"),
			).toBe(true);
		}
	},
);

it("uses the viewer's date across timezone and daylight-saving boundaries", () => {
	const card = { metadata: { remind_at: "2026-10-28" } };
	const now = new Date("2026-10-27T23:00:00Z");
	expect(cardIsDue(card, now, "Europe/Berlin")).toBe(true);
	expect(cardIsDue(card, now, "America/Los_Angeles")).toBe(false);
	const dst = { scheduledAt: "2026-10-25T08:00:00Z" };
	expect(
		cardIsDue(dst, new Date("2026-10-24T22:00:00Z"), "Europe/Berlin"),
	).toBe(true);
});

it("honors all schedule fields without hiding undated or invalid cards", () => {
	const now = new Date("2026-10-18T12:00:00Z");
	expect(
		cardIsDue(
			{ dueAt: "2026-10-17", metadata: { scheduledAt: "2026-10-28" } },
			now,
			"UTC",
		),
	).toBe(false);
	expect(cardIsDue({ dueAt: "invalid", remindAt: null }, now, "UTC")).toBe(
		true,
	);
	expect(cardIsDue({ expiresAt: "2026-10-28" }, now, "UTC")).toBe(true);
	expect(cardIsDue({}, now, "UTC")).toBe(true);
});
