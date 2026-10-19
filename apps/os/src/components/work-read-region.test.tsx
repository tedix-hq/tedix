import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
	WorkReadRegion,
	WorkReadNotice,
	useWorkReadFailure,
	supportReference,
} from "./work-read-region";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

it("combines list and detail errors, keeps loaded content, and clears only after all recover", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const retry = vi.fn();
	const error = { data: { traceId: "11111111-1111-4111-8111-111111111111" } };
	function Detail({ failed }: { failed: boolean }) {
		useWorkReadFailure(failed ? { error, retrying: false, retry } : undefined);
		return <p>Last good decision</p>;
	}
	const render = (list: boolean, detail: boolean, partial: boolean) =>
		root.render(
			<WorkReadRegion>
				<WorkReadNotice failed={list} partial={partial} retry={retry} />
				<Detail failed={detail} />
			</WorkReadRegion>,
		);
	await act(async () => render(true, true, true));
	expect(host.textContent).toContain("Last good decision");
	expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
	expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
	await act(async () => render(false, true, false));
	expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
	expect(host.querySelectorAll("button")).not.toHaveLength(0);
	await act(async () => render(false, false, true));
	expect(host.textContent).not.toContain("couldn't load");
});

it("accepts only identifier-shaped support references", () => {
	expect(
		supportReference({ data: { traceId: "customer secret" } }),
	).toBeUndefined();
	expect(
		supportReference({
			data: { traceId: "11111111-1111-4111-8111-111111111111" },
		}),
	).toBe("11111111-1111-4111-8111-111111111111");
});
