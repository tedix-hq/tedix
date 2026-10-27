import { expect, it } from "vite-plus/test";
import { calendarDay, cardIsDue, factoryCardDeadline } from "./card-schedule";

const now = new Date("2026-10-20T12:00:00Z");

it("keeps each time zone's calendar day when formatters are reused", () => {
	const late = new Date("2026-10-20T23:30:00Z");
	for (let round = 0; round < 2; round++) {
		expect(calendarDay(late, "UTC")).toBe("2026-10-20");
		expect(calendarDay(late, "Europe/Berlin")).toBe("2026-10-21");
		expect(calendarDay(late, "America/Los_Angeles")).toBe("2026-10-20");
	}
});
it.each(["due", "dueAt", "dueDate", "due_date", "deadline"])(
	"keeps future %s visible and uses it as the deadline",
	(field) => {
		const card = {
			[field]: "2026-10-22",
			action: null,
			why: "",
			runCreatedAt: now.toISOString(),
		};
		expect(cardIsDue(card, now, "Europe/Berlin")).toBe(true);
		expect(factoryCardDeadline(card)).toBe("2026-10-22");
		expect(
			cardIsDue({ metadata: { [field]: "2026-10-22" } }, now, "Europe/Berlin"),
		).toBe(true);
	},
);
it.each([
	"scheduled",
	"scheduledAt",
	"scheduledFor",
	"scheduledDate",
	"remindAt",
	"reminderAt",
	"reminderDate",
	"showFrom",
	"show_after",
])("holds future %s until its local day", (field) => {
	const card = {
		metadata: { [field]: "2026-10-21" },
		dueAt: "2026-10-22",
		action: null,
		why: "",
		runCreatedAt: now.toISOString(),
	};
	expect(cardIsDue(card, now, "Europe/Berlin")).toBe(false);
	expect(
		cardIsDue(card, new Date("2026-10-20T22:00:00Z"), "Europe/Berlin"),
	).toBe(true);
	expect(
		cardIsDue(card, new Date("2026-10-20T22:00:00Z"), "America/Los_Angeles"),
	).toBe(false);
	expect(factoryCardDeadline(card)).toBe("2026-10-22");
	expect(factoryCardDeadline({ ...card, dueAt: undefined })).toBeNull();
	expect(cardIsDue({ metadata: card.metadata }, now, "Europe/Berlin")).toBe(
		false,
	);
});
it("uses viewer calendar days for timestamps and keeps undated and invalid cards visible", () => {
	const card = { showFrom: "2026-10-21T10:00:00Z" };
	const midnight = new Date("2026-10-20T22:00:00Z");
	expect(cardIsDue(card, midnight, "Europe/Berlin")).toBe(true);
	expect(cardIsDue(card, midnight, "America/Los_Angeles")).toBe(false);
	expect(cardIsDue({}, now, "UTC")).toBe(true);
	expect(
		cardIsDue({ showFrom: "invalid", dueAt: "2026-10-22" }, now, "UTC"),
	).toBe(true);
	expect(cardIsDue({ scheduleDates: ["2026-10-22"] }, now, "UTC")).toBe(true);
});
