const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const RINGBA_ACCOUNT_ID = process.env.RINGBA_ACCOUNT_ID;
const RINGBA_API_TOKEN  = process.env.RINGBA_API_TOKEN;

const AA_TARGETS = [
  { number: '+19543143762', campaign: 'Cobra New' },
  { number: '+18128182061', campaign: 'Cobra OG' },
  { number: '+14454450605', campaign: 'Cobra PMAX' },
  { number: '+18382700281', campaign: 'Ruby', costPerCall: 40 },
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

    allRecords.forEach(r => {
      const num = r.targetNumber || r.target || '';
      if (campaignMap[num]) {
        campaignMap[num].total++;
        if (r.hasConverted === true) campaignMap[num].connected++;
        if (r.callLengthInSeconds > 0) campaignMap[num].durations.push(r.callLengthInSeconds);
      }
    });

    const campaigns = AA_TARGETS.map(t => {
      const c = campaignMap[t.number];
      const avgSec = c.durations.length
        ? Math.round(c.durations.reduce((a, b) => a + b, 0) / c.durations.length)
        : 0;
      const result = { campaign: c.campaign, totalCalls: c.total, connectedCalls: c.connected, avgDurationSec: avgSec };
      // Flat-rate campaigns (e.g. Ruby: $40 per call) have no Google Ads spend —
      // cost is derived from call volume instead.
      if (t.costPerCall) {
        result.spend = +(c.total * t.costPerCall).toFixed(2);
        result.costPerCall = t.costPerCall;
      }
      return result;
    });

    const totalCalls     = allRecords.length;
    const connectedCalls = allRecords.filter(r => r.hasConnected === true).length;
    const durations      = allRecords.map(r => r.callLengthInSeconds || 0).filter(d => d > 0);
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
