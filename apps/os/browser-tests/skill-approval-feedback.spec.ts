import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/browser-tests/approvals-popover.html?probe";
const server = await startFixtureServer(path);
const browser = await chromium.launch();
const evidenceDir = process.env.SKILL_APPROVAL_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
try {
	for (const width of [375, 1280]) {
		for (const outcome of ["approved", "rejected", "failed"]) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			page.setDefaultTimeout(15_000);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requested!: () => void;
			const sent = new Promise<void>((resolve) => {
				requested = resolve;
			});
			await page.route("**/api/rpc/tediApprovals/resolve", async (route) => {
				requested();
				await gate;
				await route.fulfill({
					status: outcome === "failed" ? 500 : 200,
					contentType: "application/json",
					body: JSON.stringify({
						json:
							outcome === "failed"
								? { message: "Receipt unavailable" }
								: {
										status: outcome,
										actionType: "mcp.tool_call",
										description:
											"Run skill: nightly-check improvement abc12345. Nothing has run yet; approving allows one identical retry of this call.",
										review: { intent: "unknown" },
										payload: {
											kind: "mcp_tool_call",
											target: {
												transport: "rpc",
												endpoint: "skills/runWorkflow",
											},
											args: { params: { probe: true } },
										},
									},
					}),
				});
			});
			await page.goto(`${server.origin}${path}`);
			await page
				.getByRole("button", {
					name: "Action approvals: 1 waiting",
					exact: true,
				})
				.click();
			const panel = page.locator("[data-approvals-popover]");
			await panel.getByRole("button", { name: /Show details$/ }).click();
			await panel
				.getByText("Run a test of the nightly-check skill proposal.", {
					exact: true,
				})
				.waitFor();
			assert.equal(await panel.getByText(/no verified description/).count(), 0);
			assert.equal(await panel.getByRole("status").count(), 0);
			await panel
				.getByRole("button", {
					name: outcome === "rejected" ? "Reject" : "Approve",
					exact: true,
				})
				.click();
			await sent;
			assert.equal(
				await panel.getByRole("status").count(),
				0,
				"No success before server confirmation",
			);
			release();
			if (outcome === "failed") {
				await panel.getByText(/The decision could not be recorded/).waitFor();
				assert.equal(await panel.getByRole("status").count(), 0);
			} else {
				await panel
					.getByRole("status")
					.getByText(outcome === "approved" ? /Permission saved/ : /Rejected/)
					.waitFor();
			}
			assert.equal(
				await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
				true,
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/${width}-${outcome}.png`,
				});
			await page.close();
		}
	}
	console.log(
		"PASS: skill action copy, confirmed approve/reject, delayed receipt and failed receipt at 375/1280px",
	);
} finally {
	await browser.close();
	await server.stop();
}
