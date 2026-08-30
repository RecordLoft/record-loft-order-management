import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../generated/prisma/client";

declare global {
  var __recordLoftPrisma: PrismaClient | undefined;
}

function pgPoolConfig() {
  const url = new URL(process.env.DATABASE_URL!);
  // connectionString ssl* params replace any explicit `ssl` object in node-pg.
  // Strip them so we can verify against the bundled Aiven project CA.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslcert");
  url.searchParams.delete("sslkey");
  url.searchParams.delete("uselibpqcompat");

  const ca = fs.readFileSync(
    path.join(process.cwd(), "certs/aiven-ca.pem"),
    "utf8",
  );

  return {
    connectionString: url.toString(),
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
    // One connection per process. Cloud Run is concurrency=1 / max-instances=2
    // so the worker stays at two Aiven clients. Netlify admin instances are
    // the same: a pool >1 here would multiply by however many are warm.
    max: 1,
    // pg defaults to 10s, which drops the socket between webhook bursts and
    // makes the next request pay a fresh TCP + TLS handshake.
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 20_000,
  };
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(pgPoolConfig());
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__recordLoftPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__recordLoftPrisma = prisma;
}

export default prisma;
