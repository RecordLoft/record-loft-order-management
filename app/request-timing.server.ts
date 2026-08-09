declare global {
  var __recordLoftInstanceWarmed: boolean | undefined;
}

/** True only for the first call on this serverless instance. */
export function consumeColdStartFlag(): boolean {
  if (globalThis.__recordLoftInstanceWarmed) return false;
  globalThis.__recordLoftInstanceWarmed = true;
  return true;
}

export function msSince(start: number): number {
  return Math.round(performance.now() - start);
}
