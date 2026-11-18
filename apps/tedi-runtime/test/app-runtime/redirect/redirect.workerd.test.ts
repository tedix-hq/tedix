import { expect, it } from "vite-plus/test";

it("sends manual fetches and exposes redirects without following them in workerd", async () => {
	const response = await fetch("https://redirect.example.test/start", {
		redirect: "manual",
	});
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toBe(
		"https://redirect.example.test/target",
	);
	await response.body?.cancel();
});

it("rejects the unsupported error redirect mode in workerd", async () => {
	await expect(
		fetch("https://redirect.example.test/start", { redirect: "error" }),
	).rejects.toThrow(TypeError);
});
