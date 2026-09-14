/**
 * Service-to-service auth for outbound HTTP (CPR template-snapshot).
 * Aligns with monitoring-runtime / threshold-runtime: Bearer INTERNAL_SERVICE_TOKEN.
 */

export function buildInternalServiceAuthHeader(
  token: string | undefined | null = process.env.INTERNAL_SERVICE_TOKEN,
): string {
  const t = token?.trim();
  if (!t) {
    throw new Error(
      'INTERNAL_SERVICE_TOKEN is required for Care Plan Runtime HTTP calls',
    );
  }
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}
