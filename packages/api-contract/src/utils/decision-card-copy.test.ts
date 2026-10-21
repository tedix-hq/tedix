import { expect, it } from "vite-plus/test";
import {
	decisionCardFaceText,
	decisionCardActionLabel,
	renderCardDateText,
	renderDecisionCardDates,
} from "./decision-card-copy";
const copy = {
	version: 2,
	title: "Save a task?",
	context: "The workshop is tomorrow.",
	body: "Creates a reminder.",
	recommendation: "The organizer needs a guest list.",
	generatedAt: "2026-10-19T12:00:00Z",
};
it.each([
	["2026-10-19T12:00:00Z", "tomorrow"],
	["2026-10-20T12:00:00Z", "today"],
	["2026-10-22T12:00:00Z", "2 days ago"],
])("renders the same stored date against %s", (now, expected) => {
	expect(
		renderDecisionCardDates(
			copy,
			["2026-10-20"],
			new Date(now),
			"Europe/Berlin",
		).context,
	).toBe(`The workshop is ${expected}.`);
	expect(copy.context).toBe("The workshop is tomorrow.");
});
it("uses calendar days across timezone and DST boundaries", () => {
	expect(
		renderCardDateText("Due in 2 days.", {
			generatedAt: "2026-10-24T00:00:00Z",
			dates: ["2026-10-26"],
			now: new Date("2026-10-25T23:30:00Z"),
			timeZone: "Europe/Berlin",
		}),
	).toBe("Due today.");
});
it.each(["today", "tomorrow", "yesterday", "in 2 days", "2 days ago"])(
	"drops unbound %s sentences while retaining supported copy",
	(phrase) => {
		expect(renderCardDateText(`The event is ${phrase}. Bring a charger.`)).toBe(
			"Bring a charger.",
		);
		expect(
			renderCardDateText(`The event is ${phrase}.`, {
				generatedAt: copy.generatedAt,
				dates: ["2027-01-01"],
			}),
		).toBe("");
	},
);
it("keeps absolute dates and meaningful numbers intact", () => {
	expect(renderCardDateText("Bring 2 chargers on 2026-10-20.")).toBe(
		"Bring 2 chargers on 2026-10-20.",
	);
});
it("omits unknown confidence from plain text while retaining assessed confidence", () => {
	expect(decisionCardFaceText(copy)).not.toContain("Confidence not assessed");
	expect(decisionCardFaceText(copy, 0.8)).toContain("80% sure");
});

it("keeps the explicit decline even when generated button copy suggests yes", () => {
	expect(
		decisionCardActionLabel(
			{ ...copy, actionLabels: { reject: "Yes" } },
			"no",
			"reject",
			"No / Not needed",
		),
	).toBe("No / Not needed");
});

it("formats stored ISO deadlines across every face field without changing source dates", () => {
	const source = {
		...copy,
		context: "Review by 2026-11-14.",
		actionLabels: { approve: "Review 2026-11-14" },
	};
	const rendered = renderDecisionCardDates(
		source,
		["2026-11-14"],
		new Date("2026-10-21T12:00:00Z"),
		"Europe/Berlin",
	);
	expect(rendered.context).toBe("Review by Nov 14, 2026.");
	expect(rendered.actionLabels.approve).toBe("Review Nov 14, 2026");
	expect(source.context).toBe("Review by 2026-11-14.");
});
