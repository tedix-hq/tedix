import { getMigratedSqliteTemplate } from "./migrated-sqlite-template";

export default function setupMigratedSqliteTemplates(): void {
	getMigratedSqliteTemplate();
	getMigratedSqliteTemplate({ foreignKeys: false });
}
