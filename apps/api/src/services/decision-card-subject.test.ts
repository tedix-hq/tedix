import { expect, it } from "vite-plus/test";
import { nextStepCard } from "./decision-card-subject";

const card = (subject: string, prompt = "") =>
	nextStepCard({ subject, prompt, metadata: {} });

it("treats an access grant as consent, not every use of authorize", () => {
	expect(card("Authorize read access for Devin in the consent tab")).toBe(
		"consent",
	);
	expect(card("Sign in again", "Waiting for the owner's consent.")).toBe(
		"consent",
	);
	// A go-ahead on ordinary work performs no access step.
	expect(card("Authorize following up with Morgan about dates?")).toBeNull();
});
