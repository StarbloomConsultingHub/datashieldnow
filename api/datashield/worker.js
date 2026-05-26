// DataShield — POST /api/datashield/worker
// Called by Upstash QStash — runs Playwright scans, updates DB per-site
// Can run up to 5 minutes (set by QStash timeout)

import { neon } from '@neondatabase/serverless';
import { chromium } from '@playwright/test';

const sql = neon(process.env.DATABASE_URL);

const BROKERS = [
  { name: 'Spokeo', scanUrl: (f, l) => `https://www.spokeo.com/${f}-${l}` },
  { name: 'BeenVerified', scanUrl: (f, l) => `https://www.beenverified.com/people/${f}-${l}/` },
  { name: 'Whitepages', scanUrl: (f, l) => `https://www.whitepages.com/name/${f}-${l}` },
  { name: 'Intelius', scanUrl: (f, l) => `https://www.intelius.com/people-search/${f}-${l}` },
  { name: 'MyLife', scanUrl: (f, l) => `https://www.mylife.com/${f}${l}` },
  { name: 'FamilyTreeNow', scanUrl: (f, l) => `https://www.familytreenow.com/search?first=${f}&last=${l}` },
  { name: 'PeekYou', scanUrl: (f, l) => `https://peekyou.com/${f}_${l}` },
  { name: 'Radaris', scanUrl: (f, l) => `https://radaris.com/p/${f}/${l}/` },
  { name: 'TruePeopleSearch', scanUrl: (f, l) => `https://www.truepeoplesearch.com/results?name=${f}%20${l}` },
  { name: 'FastPeopleSearch', scanUrl: (f, l) => `https://www.fastpeoplesearch.com/name/${f}-${l}` },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { scanId, name, email } = req.body;
  if (!scanId) return res.status(400).json({ error: 'scanId required' });

  console.log(`[Worker] Starting scan ${scanId} for ${name} <${email}>`);

  // Update scan status to running
  await sql`UPDATE scans SET status = 'running' WHERE id = ${scanId}`;

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const summary = { total: 0, exposed: 0, cleared: 0, blocked: 0, errors: 0 };

  try {
    for (const broker of BROKERS) {
      // Mark as currently scanning
      await sql`
        UPDATE exposures SET status = 'scanning'
        WHERE scan_id = ${scanId} AND site = ${broker.name}
      `;

      const url = broker.scanUrl(firstName, lastName);
      let siteResult = { status: 'error', found: false, notes: '' };

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000); // Let JS render

        const content = await page.textContent('body');
        const lower = content.toLowerCase();
        const nameLower = name.toLowerCase();

        // Detect captcha/bot blocks
        if (lower.includes('captcha') || lower.includes('robot') || lower.includes('verify you are human')) {
          siteResult = { status: 'blocked', found: false, notes: 'Captcha or bot detection triggered' };
        }
        // Detect no results
        else if (/no results found|0 results|no records found|we couldn't find|did not match any records|enter a name to get started/i.test(lower)) {
          siteResult = { status: 'not_found', found: false, notes: 'No record found' };
        }
        // Detect exposure — name present plus positive indicators
        else {
          const hasNameInPage = lower.includes(nameLower) || lower.includes(email.toLowerCase());
          const hasResultIndicator = /profile|record found|results for|view details|unlock report|see full profile|background report|people search results|matches found|possible matches|possible relatives|phone|address history/i.test(lower);

          if (hasNameInPage && hasResultIndicator) {
            siteResult = { status: 'exposed', found: true, notes: 'Personal data found on profile page' };
          } else if (hasNameInPage) {
            siteResult = { status: 'exposed', found: true, notes: 'Name appears on site' };
          } else {
            siteResult = { status: 'not_found', found: false, notes: 'No clear match' };
          }
        }
      } catch (err) {
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

      console.log(`[Worker] ${broker.name}: ${siteResult.status}`);

      summary.total++;
      if (siteResult.status === 'exposed') summary.exposed++;
      else if (siteResult.status === 'not_found') summary.cleared++;
      else if (siteResult.status === 'blocked') summary.blocked++;
      else summary.errors++;

      // Brief pause between sites
      await page.waitForTimeout(1000);
    }

    // Mark scan complete
    await sql`
      UPDATE scans
      SET status = 'completed',
          completed_at = NOW(),
          summary = ${JSON.stringify(summary)}::jsonb
      WHERE id = ${scanId}
    `;

    console.log(`[Worker] Scan ${scanId} complete — ${summary.exposed} exposed, ${summary.cleared} clear`);

  } catch (err) {
    console.error(`[Worker] Scan ${scanId} failed:`, err.message);
    await sql`
      UPDATE scans
      SET status = 'failed',
          completed_at = NOW(),
          summary = ${JSON.stringify({ error: err.message })}::jsonb
      WHERE id = ${scanId}
    `;
  } finally {
    await browser.close();
  }

  return res.status(200).json({ ok: true });
}
