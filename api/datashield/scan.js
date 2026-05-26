// DataShield — POST /api/datashield/scan
// Vercel Serverless Function
// Returns 200 immediately with UUID scan_id, offloads Jina AI scraping to Upstash QStash

// Neon serverless driver — Vercel edge compatible
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email required' });
  }

  try {
    // 1. Create scan record with UUID (Node 19+ compat: fallback for <19)
    const scanId = crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    // Postgres already has pgcrypto extension from schema migration
    await sql`
      INSERT INTO scans (id, customer_name, customer_email, status, started_at)
      VALUES (${scanId}, ${name}, ${email}, 'pending', NOW())
    `;

    // 2. Pre-insert exposure rows for all broker sites
    const brokers = [
      'Spokeo', 'BeenVerified', 'Whitepages', 'Intelius', 'MyLife',
      'FamilyTreeNow', 'PeekYou', 'Radaris', 'TruePeopleSearch', 'FastPeopleSearch'
    ];
    for (const site of brokers) {
      await sql`
        INSERT INTO exposures (scan_id, site, status)
        VALUES (${scanId}, ${site}, 'pending')
      `;
    }

    // 3. Enqueue to QStash — triggers the background worker
    const qstashToken = process.env.QSTASH_TOKEN;
    if (qstashToken) {
      fetch('https://qstash-us-east-1.upstash.io/v2/publish/https://datashieldnow.com/api/datashield/worker', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${qstashToken}`,
          'Content-Type': 'application/json',
          'Upstash-Timeout': '120s',
        },
        body: JSON.stringify({ scanId, name, email }),
      });
    }

    // 4. Return 200 immediately
    return res.status(200).json({
      ok: true,
      scan_id: scanId,
      sites: brokers.length,
    });

  } catch (err) {
    console.error('[Scan] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
