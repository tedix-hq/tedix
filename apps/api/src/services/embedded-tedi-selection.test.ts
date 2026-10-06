import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	resolveEmbeddedTediSelection,
	validateEmbeddedTediSelection,
} from "./embedded-tedi-selection";
const roster = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/tedis", () => ({ getTedisByOrganization: roster }));
const one = "11111111-1111-4111-8111-111111111111",
	two = "22222222-2222-4222-8222-222222222222";
const policy = { defaultTediId: one, allowedTediIds: [one, two] };
const ctx = { db: {} } as BaseContext;
beforeEach(() => {
	roster.mockResolvedValue([
		{ id: one, name: "Engineer", status: "active", retiredAt: null },
		{ id: two, name: "Support", status: "active", retiredAt: null },
	]);
});
it("uses the configured default and permits an explicit allowed selection", async () => {
	expect(
		(await resolveEmbeddedTediSelection(ctx, "customer", policy)).tedi.id,
	).toBe(one);
	expect(
		(await resolveEmbeddedTediSelection(ctx, "customer", policy, two))
			.tediSelection,
	).toEqual({
		defaultTediId: one,
		selectedTediId: two,
		tedis: [
			{ id: one, name: "Engineer" },
			{ id: two, name: "Support" },
		],
	});
	expect(roster).toHaveBeenCalledWith(ctx.db, "customer");
});
it("refuses unconfigured widgets and unlisted workers before reading their records", async () => {
	await expect(
		resolveEmbeddedTediSelection(ctx, "customer", null),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		resolveEmbeddedTediSelection(
			ctx,
			"customer",
			{ ...policy, allowedTediIds: [one] },
			two,
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it.each(["missing", "retired", "inactive"])(
	"rejects a %s configured worker without selecting another",
	async (state) => {
		roster.mockResolvedValue(
			state === "missing"
				? []
				: [
						{
							id: two,
							name: "Support",
							status: state === "inactive" ? "paused" : "active",
							retiredAt: state === "retired" ? "2026-09-16" : null,
						},
					],
		);
		await expect(
			resolveEmbeddedTediSelection(ctx, "customer", policy, two),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		await expect(
			validateEmbeddedTediSelection(ctx, "customer", policy),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	},
);
