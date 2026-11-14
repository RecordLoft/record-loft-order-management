import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { prisma } from "./db.server";
import { prismaSessionStorageRetryOptions } from "./session-storage-retry.server";
import { PrismaSessionStorage } from "./shopify-app-session-storage-prisma.js";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma, {
    ...prismaSessionStorageRetryOptions(),
  }),
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  // Webhook subscriptions are declared in shopify.app.toml. Registering them
  // here as well makes Shopify deliver every event twice.
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
