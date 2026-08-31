import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { INTEGRATION_DATABASE_URL_FILE } from "./integration-env";

export default async function setup() {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("record_loft_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const url = container.getConnectionUri();
  writeFileSync(INTEGRATION_DATABASE_URL_FILE, url, "utf8");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  process.env.SHOPIFY_API_KEY ??= "integration-test";
  process.env.SHOPIFY_API_SECRET ??= "integration-test";
  process.env.SCOPES ??= "read_orders,write_orders";
  process.env.SHOPIFY_APP_URL ??= "https://record-loft-order-management.test";

  execSync("yarn prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  return async () => {
    await container.stop();
  };
}
