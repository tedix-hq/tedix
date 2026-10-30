import assert from "node:assert/strict";
import { runShellSpec } from "./shell-harness";

await runShellSpec(async ({ origin, newPage, pageErrors }) => {
	// Let Vite finish first-use module optimization before holding API responses.
	const warm = await newPage();
	await warm.goto(`${origin}/admin/billing`);
	await warm.getByText("Token plan allowance", { exact: true }).waitFor();
	await warm
		.getByRole("heading", { name: "Daily inference capacity", exact: true })
		.waitFor();
	await warm.close();
	for (const width of [390, 1280]) {
		for (const stalled of ["getOverview", "listPlans"]) {
			const page = await newPage({ viewport: { width, height: 900 } });
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requests = 0;
			let releasedResponses = 0;
			await page.route("**/api/rpc/billing/**", async (route) => {
				const response = await route.fetch();
				if (route.request().url().includes(stalled)) {
					requests++;
					await held;
					releasedResponses++;
				}
				if (route.request().url().includes("getOverview")) {
					const body = await response.json();
					body.json.inferenceCapacity.available = false;
					body.json.inferenceCapacity.blockingReason =
						"credit_allowance_exhausted";
					body.json.inferenceCapacity.unblockAction = "top_up";
					await route.fulfill({ response, json: body });
				} else {
					await route.fulfill({ response });
				}
			});
			try {
				await page.goto(`${origin}/admin/billing`);
				await page
					.getByRole("heading", { name: "Billing", exact: true })
					.waitFor({ timeout: 12_000 });
				assert.ok(requests > 0, "billing read started");
				assert.equal(
					releasedResponses,
					0,
					"billing shell renders before the stalled read finishes",
				);
				release();
				const reason = page.getByText(
					"There are not enough usage credits for this request. (credit_allowance_exhausted)",
					{ exact: true },
				);
				await reason.nth(1).waitFor();
				assert.equal(
					await reason.count(),
					2,
					"wallet and inference status agree",
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
		"PASS: billing renders with stalled overview/plans, then shows matching credit denial reasons; phone and desktop",
	);
});
