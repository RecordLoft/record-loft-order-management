import { Config } from "@netlify/functions";
import { prisma } from "../../app/db.server";

export default async (_req: Request) => {
  try {
    const sessionCount = await prisma.session.count();

    console.log(
      `DB ping ok. Current App Sessions: ${sessionCount}`,
    );
    return new Response("Database is awake!", { status: 200 });
  } catch (error) {
    console.error("Failed to ping database:", error);
    return new Response("Database ping failed", { status: 500 });
  }
};

// CRON CONFIGURATION: Runs every single hour, 24/7/365
export const config: Config = {
  schedule: "0 * * * *",
};
