// ─────────────────────────────────────────────────────────────
// revrise.js — RevRise campaign billing via CallTrackingMetrics
//
// Second CTM account (551841). Counts calls on the two RevRise
// tracking numbers and bills a flat rate for every call tagged
// "first time caller". Does not touch the existing Ringba routes
// or the original CTM credentials.
//
// Mount in api/index.js:
//   const revrise = require('./revrise');
//   app.use(revrise);
//
// Required Railway env vars:
//   CTM_REVRISE_KEY          API access key for account 551841
//   CTM_REVRISE_SECRET       API secret for account 551841
// Optional:
//   CTM_REVRISE_ACCOUNT_ID   defaults to 551841
//   REVRISE_RATE             defaults to 100
// ─────────────────────────────────────────────────────────────

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const CTM_HOST   = 'api.calltrackingmetrics.com';
const ACCOUNT_ID = process.env.CTM_REVRISE_ACCOUNT_ID || '551841';
const RATE       = parseFloat(process.env.REVRISE_RATE || '100');
const TZ         = 'America/New_York';

// Billable tag, lowercase. Compared case-insensitively.
const BILLABLE_TAG = 'first time caller';
const REPEAT_TAG   = 'repeat caller';

// The two RevRise tracking numbers, E.164. Digits are compared
// with formatting stripped, so (888) 621-7222 matches +18886217222.
const REVRISE_NUMBERS = [
  '+18886217222',
  '+18775173466',
];

const digits = s => String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
const NUMBER_SET = new Set(REVRISE_NUMBERS.map(digits));

function authHeader() {
  const key    = process.env.CTM_REVRISE_KEY;
  const secret = process.env.CTM_REVRISE_SECRET;
  if (!key || !secret) {
    throw new Error('CTM_REVRISE_KEY / CTM_REVRISE_SECRET not set');
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

// CTM field names vary a little by account and API version, so pull
// the tag list out of whichever shape comes back rather than assuming one.
function extractTags(call) {
  const raw = call.tag_list ?? call.tags ?? call.tag ?? [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr
    .map(t => (typeof t === 'string' ? t : (t && (t.name || t.tag)) || ''))
    .map(t => String(t).trim().toLowerCase())
    .filter(Boolean);
}

// Same defensive approach for the tracking number the caller dialed.
function extractTrackingNumber(call) {
  const candidates = [
    call.tracking_number,
    call.tracking,
    call.tracking_phone_number,
    call.receiving_number,
    call.number,
    call.tracking_label,
    call.dialed_number,
  ];
  for (const c of candidates) {
    const d = digits(c);
    if (d && NUMBER_SET.has(d)) return d;
  }
  // Nested shapes, e.g. { tracking_number: { number: "+1888..." } }
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const d = digits(c.number || c.phone_number || c.formatted);
      if (d && NUMBER_SET.has(d)) return d;
    }
  }
  return null;
}

// Day bucket in Eastern time. CTM's called_at is a non-ISO string
// ("2026-09-19 08:19 PM -04:00") that parses correctly on current Node but
// isn't guaranteed to, so prefer unix_time when the record carries it.
function easternDay(call) {
  const d = call.unix_time
    ? new Date(call.unix_time * 1000)
    : new Date(call.called_at || call.start_time || call.created_at || '');
  if (!d || isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function fetchAllCalls(dateFrom, dateTo) {
  const calls = [];
  let page = 1;
  const MAX_PAGES = 100; // 10k calls ceiling; guards against runaway paging

  while (page <= MAX_PAGES) {
    const url = `https://${CTM_HOST}/api/v1/accounts/${ACCOUNT_ID}/calls.json`
      + `?start_date=${encodeURIComponent(dateFrom)}`
      + `&end_date=${encodeURIComponent(dateTo)}`
      + `&per_page=100&page=${page}`;

    const res = await fetch(url, {
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CTM ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = data.calls || data.activities || [];
    calls.push(...batch);

    const totalPages = data.total_pages || data.pages || 1;
    if (batch.length === 0 || page >= totalPages) break;
    page++;
  }
  return calls;
}

// ── MAIN ROUTE ───────────────────────────────────────────────
router.post('/api/revrise', async (req, res) => {
  const { dateFrom, dateTo } = req.body || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required (YYYY-MM-DD)' });
  }

  try {
    const all = await fetchAllCalls(dateFrom, dateTo);

    let totalCalls = 0;
    let billableCalls = 0;
    let repeatCalls = 0;
    let untaggedCalls = 0;
    const byNumber = {};
    const byDay = {};

    for (const call of all) {
      const num = extractTrackingNumber(call);
      if (!num) continue; // not a RevRise number — ignore

      // CTM's new/repeat auto-tag only fires on inbound calls. Outbound dials
      // and agent callbacks on the same tracking number arrive with no tag at
      // all, which would otherwise show up as unbilled "untagged" calls.
      const dir = String(call.direction || 'inbound').toLowerCase();
      if (dir !== 'inbound') continue;

      const day = easternDay(call);
      if (day && (day < dateFrom || day > dateTo)) continue; // ET boundary correction

      const tags = extractTags(call);
      const isBillable = tags.includes(BILLABLE_TAG);
      const isRepeat   = tags.includes(REPEAT_TAG);

      totalCalls++;
      if (isBillable) billableCalls++;
      else if (isRepeat) repeatCalls++;
      else untaggedCalls++;

      byNumber[num] = byNumber[num] || { total: 0, billable: 0, repeat: 0 };
      byNumber[num].total++;
      if (isBillable) byNumber[num].billable++;
      if (isRepeat) byNumber[num].repeat++;

      if (day) {
        byDay[day] = byDay[day] || { total: 0, billable: 0 };
        byDay[day].total++;
        if (isBillable) byDay[day].billable++;
      }
    }

    res.json({
      campaign: 'RevRise',
      accountId: ACCOUNT_ID,
      rate: RATE,
      dateFrom,
      dateTo,
      timezone: TZ,
      totalCalls,
      billableCalls,
      repeatCalls,
      untaggedCalls,
      spend: +(billableCalls * RATE).toFixed(2),
      byNumber,
      byDay,
    });
  } catch (err) {
    console.error('[revrise]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG ROUTE ──────────────────────────────────────────────
// Returns one raw CTM call object so you can confirm the real field
// names on account 551841 before trusting the counts. Hit it once
// after deploy, then ignore it.
//   curl -X POST https://<proxy>/api/revrise/debug \
//     -H 'Content-Type: application/json' \
//     -d '{"dateFrom":"2026-09-01","dateTo":"2026-09-19"}'
router.post('/api/revrise/debug', async (req, res) => {
  const { dateFrom, dateTo } = req.body || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required' });
  }
  try {
    const all = await fetchAllCalls(dateFrom, dateTo);
    const sample = all[0] || null;
    const mine = all.filter(c => extractTrackingNumber(c));
    const untagged = mine.filter(c => {
      const t = extractTags(c);
      return !t.includes(BILLABLE_TAG) && !t.includes(REPEAT_TAG);
    });
    res.json({
      fetched: all.length,
      matchedRevRiseNumbers: mine.length,
      distinctTags: [...new Set(all.flatMap(extractTags))],
      untaggedDetail: untagged.map(c => ({
        id: c.id,
        called_at: c.called_at,
        direction: c.direction,
        dial_status: c.dial_status,
        duration: c.duration,
        is_new_caller: c.is_new_caller,
        tags: extractTags(c),
        tracking_number: c.tracking_number,
      })),
      sampleKeys: sample ? Object.keys(sample) : [],
      sampleCall: sample,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
