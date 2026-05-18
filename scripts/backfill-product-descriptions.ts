/**
 * Backfill product descriptionHtml for all products in a shop.
 *
 *   SHOP=your-store.myshopify.com yarn backfill:descriptions
 *   SHOP=your-store.myshopify.com yarn backfill:descriptions -- --dry-run
 *   SHOP=your-store.myshopify.com yarn backfill:descriptions -- --limit 10
 *
 * Requires in .env: DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET
 * Optional: SHOPIFY_APP_URL (host name for API client)
 */
import "@shopify/shopify-api/adapters/node";
import { ApiVersion, shopifyApi, type Session } from "@shopify/shopify-api";
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import "dotenv/config";
import ws from "ws";
import {
  listAllProductGids,
  syncProductDescription,
  type GraphqlRequest,
} from "../app/product-description.server";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaSessionStorage } from "../app/shopify-app-session-storage-prisma.js";

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
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const shop = requireEnv("SHOP");
  const apiKey = requireEnv("SHOPIFY_API_KEY");
  const apiSecretKey = requireEnv("SHOPIFY_API_SECRET");
  const { dryRun, limit, delayMs } = parseArgs(process.argv.slice(2));

  const adapter = new PrismaNeon({ connectionString: requireEnv("DATABASE_URL") });
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
    const body = await client.request(query, options?.variables);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  console.log(
    `Backfill descriptions for ${shop}${dryRun ? " (dry run)" : ""}${limit ? `, limit ${limit}` : ""}…\n`,
  );

  const products = await listAllProductGids(graphql);
  const targets = limit ? products.slice(0, limit) : products;

  console.log(`Found ${products.length} product(s); processing ${targets.length}…\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [index, product] of targets.entries()) {
    const result = await syncProductDescription(graphql, product.id, {
      dryRun,
    });

    const label = product.title || product.id;
    if (result === "updated") {
      updated += 1;
      console.log(
        `[${index + 1}/${targets.length}] ${dryRun ? "Would update" : "Updated"}: ${label}`,
      );
    } else if (result === "skipped") {
      skipped += 1;
      console.log(`[${index + 1}/${targets.length}] Skipped (up to date): ${label}`);
    } else {
      errors += 1;
      console.log(`[${index + 1}/${targets.length}] Error: ${label}`);
    }

    if (delayMs > 0 && index < targets.length - 1) {
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
