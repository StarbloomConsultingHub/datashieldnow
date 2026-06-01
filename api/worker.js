// DataShield — POST /api/datashield/worker
// Called by Upstash QStash — scans broker sites via Jina Reader AI
// No Playwright needed — Jina handles JS rendering server-side
// Returns immediately, updates exposures table per-site for real-time polling

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_BASE = 'https://r.jina.ai';

const BROKERS = [
  { name: 'Spokeo', url: (f, l) => `https://www.spokeo.com/${f}-${l}`, type: 'name_search' },
  { name: 'BeenVerified', url: (f, l) => `https://www.beenverified.com/people/${f}-${l}/`, type: 'name_search' },
  { name: 'Whitepages', url: (f, l) => `https://www.whitepages.com/name/${f}-${l}`, type: 'name_search' },
  { name: 'Intelius', url: (f, l) => `https://www.intelius.com/people-search/${f}-${l}`, type: 'name_search' },
  { name: 'MyLife', url: (f, l) => `https://www.mylife.com/${f}${l}`, type: 'name_search' },
  { name: 'FamilyTreeNow', url: (f, l) => `https://www.familytreenow.com/search?first=${f}&last=${l}`, type: 'name_search' },
  { name: 'PeekYou', url: (f, l) => `https://peekyou.com/${f}_${l}`, type: 'name_search' },
  { name: 'Radaris', url: (f, l) => `https://radaris.com/p/${f}/${l}/`, type: 'name_search' },
  { name: 'TruePeopleSearch', url: (f, l) => `https://www.truepeoplesearch.com/results?name=${f}%20${l}`, type: 'name_search' },
  { name: 'FastPeopleSearch', url: (f, l) => `https://www.fastpeoplesearch.com/name/${f}-${l}`, type: 'name_search' },
];

// Detection logic — same as the Playwright scanner but works on rendered text
function detectExposure(pageText, userName, userEmail) {
  const lower = pageText.toLowerCase();
  const nameLower = userName.toLowerCase();

  // Negative indicators first — no results page
  if (/no results found|0 results|no records found|we couldn't find|did not match any records|enter a name to get started/i.test(lower)) {
    return { found: false, status: 'not_found', notes: 'No record found' };
  }

  // Captcha or block
  if (lower.includes('captcha') || lower.includes('verify you are human') || lower.includes('cf-browser-verify') || lower.includes('challenge-platform')) {
    return { found: false, status: 'blocked', notes: 'Bot detection or captcha triggered' };
  }

  // Positive indicators — data found
  const hasName = lower.includes(nameLower) || lower.includes(userEmail.toLowerCase());
  const hasResultIndicator = /profile|record found|results for|view details|unlock report|see full profile|background report|people search results|matches found|possible matches|possible relatives|phone|address history|age|also known as|related to/i.test(lower);

  if (hasName && hasResultIndicator) {
    return { found: true, status: 'exposed', notes: 'Personal data found on site' };
  }

  if (hasName) {
    return { found: true, status: 'exposed', notes: 'Name or email appears on site' };
  }

  return { found: false, status: 'not_found', notes: 'No clear match on page' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { scanId, name, email } = req.body;
  if (!scanId) return res.status(400).json({ error: 'scanId required' });

  console.log(`[Worker] Starting scan ${scanId} for ${name} <${email}>`);

  // Update scan status to running
  await sql`UPDATE scans SET status = 'running' WHERE id = ${scanId}`;

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const summary = { total: 0, exposed: 0, cleared: 0, blocked: 0, errors: 0 };

  try {
    for (const broker of BROKERS) {
      // Mark as scanning
      await sql`
        UPDATE exposures SET status = 'scanning'
        WHERE scan_id = ${scanId} AND site = ${broker.name}
      `;

      let siteResult = { status: 'error', found: false, notes: '' };

      try {
        const targetUrl = broker.url(firstName, lastName);
        console.log(`[Worker] ${broker.name}: fetching ${targetUrl}`);

        // Jina Reader request
        const jinaRes = await fetch(`${JINA_BASE}/${encodeURIComponent(targetUrl)}`, {
          headers: {
            'Authorization': `Bearer ${JINA_API_KEY}`,
            'X-Return-Format': 'markdown',
            'X-With-Links-Summary': 'true',
          },
          signal: AbortSignal.timeout(20000),
        });

        if (!jinaRes.ok) {
          const errText = await jinaRes.text().catch(() => '');
          console.warn(`[Worker] ${broker.name}: Jina returned ${jinaRes.status}`);
          siteResult = { status: 'error', found: false, notes: `Jina HTTP ${jinaRes.status}` };
        } else {
          const text = await jinaRes.text();
          siteResult = detectExposure(text, name, email);
        }
      } catch (err) {
        console.warn(`[Worker] ${broker.name}: error - ${err.message.substring(0, 100)}`);
        siteResult = { status: 'error', found: false, notes: err.message.substring(0, 200) };
      }

      // Write result to exposures table
      await sql`
        UPDATE exposures
        SET status = ${siteResult.status},
            found = ${siteResult.found},
            notes = ${siteResult.notes},
            checked_at = NOW()
        WHERE scan_id = ${scanId} AND site = ${broker.name}
      `;

      console.log(`[Worker] ${broker.name}: ${siteResult.status}${siteResult.found ? ' (found)' : ''}`);

      summary.total++;
      if (siteResult.status === 'exposed') summary.exposed++;
      else if (siteResult.status === 'not_found') summary.cleared++;
      else if (siteResult.status === 'blocked') summary.blocked++;
      else summary.errors++;
    }

    // Mark scan complete
    await sql`
      UPDATE scans
      SET status = 'completed',
          completed_at = NOW(),
          summary = ${JSON.stringify(summary)}::jsonb
      WHERE id = ${scanId}
    `;

    console.log(`[Worker] Scan ${scanId} complete — ${summary.exposed} exposed, ${summary.cleared} clear, ${summary.blocked} blocked`);

  } catch (err) {
    console.error(`[Worker] Scan ${scanId} failed:`, err.message);
    await sql`
      UPDATE scans
      SET status = 'failed',
          completed_at = NOW(),
          summary = ${JSON.stringify({ error: err.message })}::jsonb
      WHERE id = ${scanId}
    `;
  }

  return res.status(200).json({ ok: true });
}
