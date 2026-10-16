// @vitest-environment node
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ModelContextLike } from "./model-context";
import {
	describeModelContextApi,
	resolveModelContextSource,
	toSpecToolOutput,
	webMcpContextUnavailable,
	webMcpError,
	webMcpResult,
} from "./model-context";

type HostGlobals = typeof globalThis & {
	document?: { modelContext?: ModelContextLike };
	navigator?: { modelContext?: ModelContextLike };
};

const hostGlobals = globalThis as HostGlobals;
const originalDocument = Object.getOwnPropertyDescriptor(
	globalThis,
	"document",
);
const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);

function setHosts(hosts: {
	document?: ModelContextLike;
	navigator?: ModelContextLike;
}): void {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: hosts.document ? { modelContext: hosts.document } : {},
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: hosts.navigator ? { modelContext: hosts.navigator } : {},
	});
}

function restoreHosts(): void {
	if (originalDocument) {
		Object.defineProperty(globalThis, "document", originalDocument);
	} else {
		Reflect.deleteProperty(hostGlobals, "document");
	}
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	} else {
		Reflect.deleteProperty(hostGlobals, "navigator");
	}
}

afterEach(restoreHosts);

describe("resolveModelContextSource", () => {
	it("reports no host when neither surface carries modelContext", () => {
		setHosts({});
		expect(resolveModelContextSource()).toBeNull();
	});

	it("reports the navigator surface when only navigator carries it", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setHosts({ navigator: context });
		expect(resolveModelContextSource()).toEqual({
			context,
			source: "navigator",
		});
	});

	it("prefers the document surface when both exist", () => {
		const fromDocument: ModelContextLike = { registerTool: () => {} };
		const fromNavigator: ModelContextLike = { provideContext: () => {} };
		setHosts({ document: fromDocument, navigator: fromNavigator });
		expect(resolveModelContextSource()).toEqual({
			context: fromDocument,
			source: "document",
		});
	});
});

describe("describeModelContextApi", () => {
	it("classifies the projection API a host offers", () => {
		expect(describeModelContextApi({ registerTool: () => {} })).toBe(
			"registerTool",
		);
		expect(describeModelContextApi({ provideContext: () => {} })).toBe(
			"provideContext",
		);
		expect(
			describeModelContextApi({
				registerTool: () => {},
				provideContext: () => {},
			}),
		).toBe("registerTool");
		expect(describeModelContextApi({})).toBe("none");
		expect(describeModelContextApi(null)).toBe("none");
	});
});

describe("webMcpContextUnavailable", () => {
	it("returns the one stable, typed, retryable context_unavailable shape", () => {
		const result = webMcpContextUnavailable("Authentication required.");
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: "context_unavailable",
			retryable: true,
			detail: "Authentication required.",
		});
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);

		const bare = webMcpContextUnavailable();
		expect(bare.structuredContent).toEqual({
			error: "context_unavailable",
			retryable: true,
		});
		expect(bare.isError).toBe(true);
	});
});

describe("toSpecToolOutput", () => {
	it("returns the structured data once for a success", () => {
		expect(toSpecToolOutput(webMcpResult({ id: "w1" }, "/work/w1"))).toEqual({
			id: "w1",
			deepLink: "/work/w1",
		});
	});

	it("returns the text when a success has no structured data", () => {
		expect(
			toSpecToolOutput({ content: [{ type: "text", text: "done" }] }),
		).toBe("done");
	});

	it("rejects an error result with its text, as the spec requires", () => {
		expect(() => toSpecToolOutput(webMcpError("Not found"))).toThrow(
			"Not found",
		);
		expect(() =>
			toSpecToolOutput(webMcpContextUnavailable("org scope not bound")),
		).toThrow('"error":"context_unavailable"');
	});
});
