import path from "node:path";
import { fileURLToPath } from "node:url";

export const INTEGRATION_DATABASE_URL_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".integration-database-url",
);
