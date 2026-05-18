import { Config } from "@netlify/functions";
import { prisma } from "../../app/db.server";

export default async (req: Request) => {
  try {
    // Run an ultra-light database ping against your session store
    const sessionCount = await prisma.session.count();

    console.log(
      `☕ Supabase Pinged successfully. Current App Sessions: ${sessionCount}`,
    );
    return new Response("Supabase is awake!", { status: 200 });
  } catch (error) {
    console.error("❌ Failed to keep Supabase awake:", error);
    return new Response("Database ping failed", { status: 500 });
  }
};

// CRON CONFIGURATION: Runs every single hour, 24/7/365
export const config: Config = {
  schedule: "0 * * * *",
};
