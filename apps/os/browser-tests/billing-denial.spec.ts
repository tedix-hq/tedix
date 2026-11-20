import assert from "node:assert/strict";
import { runShellSpec } from "./shell-harness";

await runShellSpec(async ({ origin, newPage, pageErrors }) => {
	// Let Vite finish first-use module optimization before holding API responses.
	const warm = await newPage();
	await warm.goto(`${origin}/admin/billing?tab=plan`);
	await warm.getByText("Current plan", { exact: true }).waitFor();
	await warm.getByRole("button", { name: "Test checkout" }).first().waitFor();
	await warm.close();
	for (const width of [390, 1280]) {
		for (const stalled of ["getOverview", "listPlans"]) {
			const page = await newPage({ viewport: { width, height: 900 } });
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let releasedResponses = 0;
			await page.route("**/api/rpc/billing/**", async (route) => {
				const response = await route.fetch();
				if (route.request().url().includes(stalled)) {
					await held;
					releasedResponses++;
				}
				if (route.request().url().includes("getOverview")) {
					const body = await response.json();
					const credits = body.json.credits;
					credits.usedCredits = credits.includedCredits;
					credits.remainingIncludedCredits = 0;
					credits.topUpCredits = 0;
					credits.payAsYouGo.enabled = false;
					body.json.admission = {
						available: false,
						blockingReason: "monthly_credit_limit_reached",
						unblockAction: "top_up",
					};
					await route.fulfill({ response, json: body });
				} else {
					await route.fulfill({ response });
				}
			});
			try {
				await Promise.all([
					page.waitForRequest(
						(request) =>
							new URL(request.url()).pathname === `/api/rpc/billing/${stalled}`,
					),
					page.goto(`${origin}/admin/billing?tab=plan`),
				]);
				await page
					.getByRole("heading", { name: "Billing", exact: true })
					.waitFor({ timeout: 12_000 });
				assert.equal(
					releasedResponses,
					0,
					"billing shell renders before the stalled read finishes",
				);
				release();
				const reason = page.getByText("Your organization is out of credits", {
					exact: true,
				});
				await reason.first().waitFor();
				assert.equal(
					await reason.count(),
					1,
					"the out-of-credits notice shows once",
				);
				assert.ok(
					releasedResponses > 0,
					"billing data renders after the held responses finish",
				);
				assert.equal(
					await page
						.getByText("OS route load still pending", { exact: false })
						.count(),
					0,
				);
			} finally {
				release();
				await page.unrouteAll({ behavior: "wait" });
				await page.close();
			}
		}
	}
	assert.deepEqual(pageErrors, []);
	console.log(
		"PASS: billing renders with stalled overview/plans, then shows the out-of-credits notice; phone and desktop",
	);
});
