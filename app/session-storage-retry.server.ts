/** Cloud Run sets K_SERVICE. Netlify keeps the longer Aiven probe. */
export function prismaSessionStorageRetryOptions(
  env: NodeJS.ProcessEnv = process.env,
): { connectionRetries: number; connectionRetryIntervalMs: number } {
  if (env.K_SERVICE) {
    return { connectionRetries: 2, connectionRetryIntervalMs: 200 };
  }
  return { connectionRetries: 4, connectionRetryIntervalMs: 3000 };
}
