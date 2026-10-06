import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sendOpsAlert } from "./ops-alert-egress";

function emailEnv(send = vi.fn().mockResolvedValue({ messageId: "m1" })) {
	return { EMAIL: { send } as unknown as SendEmail };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("sendOpsAlert", () => {
	it("is a no-op when neither channel is configured", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const res = await sendOpsAlert(
			{},
			{ subject: "s", text: "t", emailRecipients: "", webhookUrl: "" },
		);
		expect(res).toEqual({ emailed: false, webhookPosted: false });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends email only when a recipient is set and no webhook", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const env = emailEnv();
		const res = await sendOpsAlert(env, {
			subject: "s",
			text: "t",
			emailRecipients: "a@x.com, b@x.com",
		});
		expect(res.emailed).toBe(true);
		expect(res.webhookPosted).toBe(false);
		expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
		const arg = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(arg.to).toHaveLength(2);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts the webhook backstop even with NO email recipient (dead-man's-switch)", async () => {
		const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchSpy);
		const res = await sendOpsAlert(
			{},
			{
				subject: "[Tedix Health] ✓ nominal",
				text: "heartbeat",
				emailRecipients: "",
				webhookUrl: "https://hooks.example.com/ops",
				meta: { firing: 0 },
			},
		);
		expect(res.emailed).toBe(false);
		expect(res.webhookPosted).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://hooks.example.com/ops");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body);
		expect(body.subject).toContain("nominal");
		expect(body.meta).toEqual({ firing: 0 });
	});

	it("fires both channels when both are configured", async () => {
		const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchSpy);
		const env = emailEnv();
		const res = await sendOpsAlert(env, {
			subject: "s",
			text: "t",
			emailRecipients: "a@x.com",
			webhookUrl: "https://hooks.example.com/ops",
		});
		expect(res).toEqual({ emailed: true, webhookPosted: true });
	});

	it("is fail-soft: a webhook non-2xx and an email throw never reject", async () => {
		const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
		vi.stubGlobal("fetch", fetchSpy);
		const env = emailEnv(vi.fn().mockRejectedValue(new Error("smtp down")));
		const res = await sendOpsAlert(env, {
			subject: "s",
			text: "t",
			emailRecipients: "a@x.com",
			webhookUrl: "https://hooks.example.com/ops",
		});
		expect(res.emailed).toBe(false);
		expect(res.webhookPosted).toBe(false);
	});
});
