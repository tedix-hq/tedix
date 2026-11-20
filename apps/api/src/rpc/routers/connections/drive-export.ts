import { saveExportToGoogleDrive } from "../../../services/drive-export-save";
import { AUTHZ } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedOs } from "./policy-resolution";

/** Save an exported file to the signed-in person's own connected drive. */
export const saveExportToDrive = authedOs.saveExportToDrive
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		requireOrgId(context);
		return saveExportToGoogleDrive(context, input);
	});
