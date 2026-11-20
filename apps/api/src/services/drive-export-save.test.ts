import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { saveExportToGoogleDrive } from "./drive-export-save";

describe("Save an export to Google Drive", () => {
	it("uploads the file to the person's Drive and returns its link", async () => {
		const fetchImpl = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toContain(
					"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
				);
				expect(init?.headers).toMatchObject({
					Authorization: "Bearer person-token",
				});
				const body = await new Response(init?.body).text();
				expect(body).toContain('{"name":"Budget.csv","mimeType":"text/csv"}');
				expect(body).toContain("month,total\njan,10");
				return Response.json({
					id: "drive-file-1",
					name: "Budget.csv",
					webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
				});
			},
		) as unknown as typeof fetch;
		const saved = await saveExportToGoogleDrive(
			{ env: {} } as BaseContext,
			{
				provider: "google-drive",
				connectionInstanceId: "00000000-0000-4000-8000-000000000003",
				fileName: "Budget.csv",
				mimeType: "text/csv",
				content: { encoding: "text", text: "month,total\njan,10" },
			},
			{
				resolveToken: async () => ({
					accessToken: "person-token",
					scopes: ["https://www.googleapis.com/auth/drive.file"],
				}),
				fetchImpl,
			},
		);
		expect(saved).toEqual({
			fileId: "drive-file-1",
			name: "Budget.csv",
			url: "https://drive.google.com/file/d/drive-file-1/view",
		});
	});
});
