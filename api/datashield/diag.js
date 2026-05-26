// DataShield — GET /api/datashield/diag
// Diagnostic endpoint to check env vars are loaded

export default async function handler(req, res) {
  const envKeys = ['DATABASE_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'JINA_API_KEY'];
  const envStatus = {};
  for (const key of envKeys) {
    const val = process.env[key];
    envStatus[key] = val ? `SET (${val.substring(0, 10)}...)` : 'NOT SET';
  }

  const hasGlobalCrypto = typeof crypto !== 'undefined';
  const hasRandomUUID = hasGlobalCrypto && typeof crypto.randomUUID === 'function';

  return res.status(200).json({
    env: envStatus,
    crypto: { global: hasGlobalCrypto, randomUUID: hasRandomUUID },
    node: process.version,
  });
}
