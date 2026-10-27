/**
 * Liveness endpoint used by the acceptance suite and by deployment checks.
 * Deliberately static and free of secrets.
 */
export function GET() {
  return Response.json({
    ok: true,
    app: 'CamScan',
    localFirst: true,
    time: new Date().toISOString(),
  });
}
