import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

const api = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { tediApprovals: api } }));
import { ApprovalFieldEdits, approvalEditValue } from "./approval-field-edits";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = "10000000-0000-4000-8000-000000000001";
const approval: { id: string; payload: Record<string, JsonValue> } = {
	id,
	payload: {
		kind: "home_tool_write",
		args: { folderId: "folder-1", title: "Weekly notes" },
		editableFields: [
			{
				name: "folderId",
				label: "Folder",
				required: true,
				schema: { type: "string", minLength: 1 },
			},
			{
				name: "title",
				label: "Title",
				required: true,
				schema: { type: "string", maxLength: 80 },
			},
		],
	},
};

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
	api.resolve.mockReset().mockResolvedValue({ id, status: "approved" });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

async function render(node: React.ReactNode) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={new QueryClient()}>
				{node}
			</QueryClientProvider>,
		);
	});
}

function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ApprovalFieldEdits", () => {
	it("renders nothing without editable fields or once decided", async () => {
		await render(
			<ApprovalFieldEdits
				approval={{ id, payload: { kind: "deploy" } }}
				active
			/>,
		);
		expect(host.innerHTML).toBe("");
		await render(<ApprovalFieldEdits approval={approval} active={false} />);
		expect(host.innerHTML).toBe("");
	});

	it("approves with only the changed fields", async () => {
		await render(<ApprovalFieldEdits approval={approval} active />);
		const trigger = host.querySelector("button");
		expect(trigger?.textContent).toContain("Change before approving");
		await act(async () => trigger?.click());
		const inputs = [...host.querySelectorAll("input")];
		expect(inputs.map((input) => input.value)).toEqual([
			"folder-1",
			"Weekly notes",
		]);
		const submit = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Approve with changes"),
		);
		expect(submit?.disabled).toBe(true);
		await act(async () => type(inputs[0] as HTMLInputElement, "folder-2"));
		expect(submit?.disabled).toBe(false);
		await act(async () => {
			host
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(api.resolve).toHaveBeenCalledWith({
			id,
			status: "approved",
			edits: { folderId: "folder-2" },
			resolution: "Approved with changes to Folder",
		});
	});

	it("blocks a change the tool schema refuses", async () => {
		await render(<ApprovalFieldEdits approval={approval} active />);
		await act(async () => host.querySelector("button")?.click());
		const title = host.querySelectorAll("input")[1] as HTMLInputElement;
		await act(async () => type(title, ""));
		await act(async () => {
			host
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(api.resolve).not.toHaveBeenCalled();
		expect(host.textContent).toContain("Title is required");
	});
});

describe("approvalEditValue", () => {
	it("converts form text back to the schema type", () => {
		const field = (schema: Record<string, unknown>) => ({
			name: "x",
			label: "X",
			required: false,
			schema: schema as never,
		});
		expect(approvalEditValue(field({ type: "integer" }), "3")).toBe(3);
		expect(approvalEditValue(field({ enum: [1, 2] }), "2")).toBe(2);
		expect(approvalEditValue(field({ type: "boolean" }), true)).toBe(true);
		expect(approvalEditValue(field({ type: "string" }), "  ")).toBeNull();
	});
});
