// DataShield — GET /api/datashield/status?scan_id=UUID
// Vercel Serverless Function
// Returns scan metadata + per-site exposure status for frontend polling

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  const { scan_id } = req.query;

  if (!scan_id) {
    return res.status(400).json({ error: 'scan_id required' });
  }

  // Validate UUID format — prevent injection or sequential probing
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scan_id)) {
    return res.status(400).json({ error: 'invalid scan_id format' });
  }

  try {
    const scan = await sql`
      SELECT id, customer_name, customer_email, status, started_at, completed_at, summary
      FROM scans WHERE id = ${scan_id}
    `;

    if (scan.length === 0) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    const exposures = await sql`
      SELECT site, status, found, notes, checked_at
      FROM exposures WHERE scan_id = ${scan_id}
      ORDER BY site
    `;

    return res.status(200).json({
      scan: scan[0],
      exposures,
    });

  } catch (err) {
    console.error('[Status] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
