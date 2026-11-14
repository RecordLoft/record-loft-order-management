import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { PrismaClient } from "../generated/prisma/client";

declare global {
  var __recordLoftPrisma: PrismaClient | undefined;
}

function usesAivenSsl(url: URL): boolean {
  const sslMode = url.searchParams.get("sslmode");
  return (
    sslMode === "require" ||
    sslMode === "verify-full" ||
    sslMode === "verify-ca" ||
    url.searchParams.has("sslrootcert")
  );
}

function pgPoolConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is not set");
  }
  const url = new URL(raw);
  const withAivenSsl = usesAivenSsl(url);
  // connectionString ssl* params replace any explicit `ssl` object in node-pg.
  // Strip them so we can verify against the bundled Aiven project CA.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslcert");
  url.searchParams.delete("sslkey");
  url.searchParams.delete("uselibpqcompat");

  const base = {
    connectionString: url.toString(),
    // One connection per process. Cloud Run is concurrency=1 / max-instances=2
    // so the worker stays at two Aiven clients. Netlify admin instances are
    // the same: a pool >1 here would multiply by however many are warm.
    max: 1,
    // pg defaults to 10s, which drops the socket between webhook bursts and
    // makes the next request pay a fresh TCP + TLS handshake.
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 20_000,
  };

  // Local / Testcontainers URLs have no sslmode. Aiven always sets require.
  if (!withAivenSsl) {
    return base;
  }

  const ca = fs.readFileSync(
    path.join(process.cwd(), "certs/aiven-ca.pem"),
    "utf8",
  );

  return {
    ...base,
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
  };
}

const pool = new Pool(pgPoolConfig());

function createPrismaClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export const prisma = globalThis.__recordLoftPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__recordLoftPrisma = prisma;
}

export async function closeDb(): Promise<void> {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

export default prisma;
