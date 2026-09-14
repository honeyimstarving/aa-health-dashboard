const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const RINGBA_ACCOUNT_ID = process.env.RINGBA_ACCOUNT_ID;
const RINGBA_API_TOKEN  = process.env.RINGBA_API_TOKEN;

// Number → campaign label. These labels must match the dashboard's card labels
// (the frontend normalizes minor variations, but keep them exact where possible).
const AA_TARGETS = [
  { number: '+19543143762', campaign: 'Cobra New' },
  { number: '+18128182061', campaign: 'Cobra OG' },
  { number: '+14454450605', campaign: 'Cobra PMAX' },
  { number: '+18382700281', campaign: 'Ruby' },
  { number: '+12186717636', campaign: 'Carrier' },
];

app.get('/', (req, res) => res.json({ status: 'AA Health proxy running' }));

app.post('/api/calls', async (req, res) => {
  const { dateFrom, dateTo, targets } = req.body;
  const targetNumbers =
    Array.isArray(targets) && targets.length
        ? targets
        : AA_TARGETS.map(t => t.number);

  const reportStart = `${dateFrom}T00:00:00`;
  const reportEnd   = `${dateTo}T23:59:59`;

  try {
    let allRecords = [];
    let offset = 0;
    const size = 1000;

    while (true) {
      const payload = {
        reportStart,
        reportEnd,
        filters: [
          {
            anyCondition: true,
            conditions: targetNumbers.map(num => ({
              column: 'targetNumber',
              operator: 'Equals',
              value: num,
            })),
          },
        ],
        offset,
        size,
      };

      const rbRes = await fetch(
        `https://api.ringba.com/v2/${RINGBA_ACCOUNT_ID}/calllogs`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${RINGBA_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );

      if (!rbRes.ok) {
        const errText = await rbRes.text();
        throw new Error(`Ringba API ${rbRes.status}: ${errText}`);
      }

      const rbData = await rbRes.json();
      const records = (rbData.report && rbData.report.records) || rbData.callLogs || rbData.records || rbData.data || [];
      allRecords = allRecords.concat(records);

      if (records.length < size) break;
      offset += size;
    }

    // Build per-campaign stats
    const campaignMap = {};
    AA_TARGETS.forEach(t => {
      campaignMap[t.number] = { campaign: t.campaign, total: 0, connected: 0, durations: [] };
    });

    // Only calls to mapped targets count. Anything else (other accounts' targets
    // bleeding through the filter, records with no target number) is dropped from
    // both the per-campaign rows and the totals, so the table always sums to the
    // top-line figure. To surface a number here instead of dropping it, add it to
    // AA_TARGETS above.
    const mappedRecords = allRecords.filter(r => campaignMap[r.targetNumber || r.target || '']);

    mappedRecords.forEach(r => {
      const bucket = campaignMap[r.targetNumber || r.target || ''];
      bucket.total++;
      if (r.hasConverted === true) bucket.connected++;
      if (r.callLengthInSeconds > 0) bucket.durations.push(r.callLengthInSeconds);
    });

    const campaigns = AA_TARGETS.map(t => {
      const c = campaignMap[t.number];
      const avgSec = c.durations.length
        ? Math.round(c.durations.reduce((a, b) => a + b, 0) / c.durations.length)
        : 0;
      return { campaign: c.campaign, totalCalls: c.total, connectedCalls: c.connected, avgDurationSec: avgSec };
    });

    const totalCalls     = mappedRecords.length;
    const connectedCalls = mappedRecords.filter(r => r.hasConnected === true).length;
    const durations      = mappedRecords.map(r => r.callLengthInSeconds || 0).filter(d => d > 0);
    const avgDurationSec = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    res.json({ totalCalls, connectedCalls, avgDurationSec, campaigns });
  } catch (err) {
    console.error('Ringba error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AA Health proxy on port ${PORT}`));
