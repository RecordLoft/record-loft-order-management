/**
 * Bulk-sync product descriptionHtml from metafields for Shop-published products.
 *
 * Options: --dry-run, --limit N, --delay-ms N (default 250),
 * --from N (resume at 1-based index), --max-retries N (default 5).
 */
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { ApiVersion, shopifyApi, type Session } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import "dotenv/config";
import ws from "ws";
import {
  listShopPublishedProductGids,
  syncProductDescription,
  type DescriptionSyncResult,
  type GraphqlRequest,
} from "../app/product-description.server";
import { PrismaSessionStorage } from "../app/shopify-app-session-storage-prisma.js";
import { PrismaClient } from "../generated/prisma/client";

neonConfig.webSocketConstructor = ws;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    limit: (() => {
      const index = argv.indexOf("--limit");
      if (index === -1) return undefined;
      const value = Number(argv[index + 1]);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    })(),
    delayMs: (() => {
      const index = argv.indexOf("--delay-ms");
      if (index === -1) return 250;
      const value = Number(argv[index + 1]);
      return Number.isFinite(value) && value >= 0 ? value : 250;
    })(),
    from: (() => {
      const index = argv.indexOf("--from");
      if (index === -1) return 1;
      const value = Number(argv[index + 1]);
      return Number.isFinite(value) && value >= 1 ? value : 1;
    })(),
    maxRetries: (() => {
      const index = argv.indexOf("--max-retries");
      if (index === -1) return 5;
      const value = Number(argv[index + 1]);
      return Number.isFinite(value) && value >= 1 ? value : 5;
    })(),
  };
}

function isRetriableShopifyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response = (error as { response?: { code?: number } }).response;
  const code = response?.code;
  if (code === 429 || code === 502 || code === 503) return true;
  const name = (error as { constructor?: { name?: string } }).constructor?.name;
  return (
    name === "HttpInternalError" ||
    name === "HttpThrottlingError" ||
    name === "HttpMaxRetriesError"
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function syncWithRetries(
  graphql: GraphqlRequest,
  productGid: string,
  options: { dryRun?: boolean; maxRetries: number },
): Promise<DescriptionSyncResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    try {
      return await syncProductDescription(graphql, productGid, {
        dryRun: options.dryRun,
      });
    } catch (error) {
      lastError = error;
      if (!isRetriableShopifyError(error) || attempt === options.maxRetries) {
        throw error;
      }
      const waitMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const shop = requireEnv("SHOP");
  const apiKey = requireEnv("SHOPIFY_API_KEY");
  const apiSecretKey = requireEnv("SHOPIFY_API_SECRET");
  const { dryRun, limit, delayMs, from, maxRetries } = parseArgs(
    process.argv.slice(2),
  );

  const adapter = new PrismaNeon({
    connectionString: requireEnv("DATABASE_URL"),
  });
  const prisma = new PrismaClient({ adapter });
  const sessionStorage = new PrismaSessionStorage(prisma);

  const sessions = await sessionStorage.findSessionsByShop(shop);
  const session =
    sessions.find((s: Session) => !s.isOnline && s.accessToken) ??
    sessions.find((s: Session) => Boolean(s.accessToken));

  if (!session) {
    console.error(
      `No session for ${shop}. Open the app on that store first so an offline token is saved.`,
    );
    process.exit(1);
  }

  const hostName =
    process.env.SHOPIFY_APP_URL?.replace(/^https?:\/\//, "") ?? "localhost";

  const shopify = shopifyApi({
    apiKey,
    apiSecretKey,
    apiVersion: ApiVersion.October25,
    isEmbeddedApp: true,
    hostName,
  });

  const client = new shopify.clients.Graphql({ session });

  const graphql: GraphqlRequest = async (query, options) => {
    const body = await client.request(query, {
      ...options,
      retries: 3,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  console.log(
    `Backfill descriptions for ${shop}${dryRun ? " (dry run)" : ""}${limit ? `, limit ${limit}` : ""}…\n`,
  );

  console.log("Listing products published on Shop channel…\n");

  const products = await listShopPublishedProductGids(graphql);
  const targets = limit ? products.slice(0, limit) : products;

  const processing = from > 1 ? targets.slice(from - 1) : targets;
  console.log(
    `Found ${products.length} Shop-published product(s); processing ${processing.length}` +
      (from > 1 ? ` (from #${from})` : "") +
      "…\n",
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [offset, product] of processing.entries()) {
    const position = from > 1 ? from + offset : offset + 1;
    const label = product.title || product.id;

    let result: DescriptionSyncResult;
    try {
      result = await syncWithRetries(graphql, product.id, {
        dryRun,
        maxRetries,
      });
    } catch (error) {
      errors += 1;
      console.log(
        `[${position}/${targets.length}] Error: ${label} — ${formatError(error)}`,
      );
      if (delayMs > 0 && offset < processing.length - 1) {
        await sleep(delayMs);
      }
      continue;
    }
    if (result.outcome === "updated") {
      updated += 1;
      console.log(
        `[${position}/${targets.length}] ${dryRun ? "Would update" : "Updated"}: ${label}`,
      );
    } else if (result.outcome === "skipped") {
      skipped += 1;
      console.log(
        `[${position}/${targets.length}] Skipped (up to date): ${label}`,
      );
    } else {
      errors += 1;
      console.log(
        `[${position}/${targets.length}] Error: ${label} — ${result.message}`,
      );
    }

    if (delayMs > 0 && offset < processing.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log(
    `\nDone. ${updated} ${dryRun ? "would update" : "updated"}, ${skipped} skipped, ${errors} error(s).`,
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
