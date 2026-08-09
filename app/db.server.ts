import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";

declare global {
  var __recordLoftPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    // Supabase's pooler serves a self-signed chain, so the connection is
    // encrypted but the chain is not verifiable without their CA bundle.
    ssl: { rejectUnauthorized: false },
    // Each Netlify function instance holds its own pool, so keep the ceiling
    // low: exhaustion queues locally instead of consuming the shared
    // Supavisor client budget.
    max: 3,
    // pg defaults to 10s, which drops the socket between webhook bursts and
    // makes the next request pay a fresh TCP + TLS handshake.
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 10_000,
  });

  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__recordLoftPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__recordLoftPrisma = prisma;
}

export default prisma;
