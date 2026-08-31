import { readFileSync } from "node:fs";
import { INTEGRATION_DATABASE_URL_FILE } from "./integration-env";

const url = readFileSync(INTEGRATION_DATABASE_URL_FILE, "utf8").trim();
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
