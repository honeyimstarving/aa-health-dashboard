const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ── RINGBA CONFIG ────────────────────────────
const RINGBA_ACCOUNT_ID = process.env.RINGBA_ACCOUNT_ID;
const RINGBA_API_TOKEN  = process.env.RINGBA_API_TOKEN;

// AA Health target phone numbers
const AA_TARGETS = [
  '+19543143762', // AA Health Cobra New
  '+18128182061', // AA Health Cobra OG
  '+14454450605', // AA Health Cobra PMAX
  '+18382700281', // AA Health Ruby
];

// ── HEALTH CHECK ─────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AA Health proxy running' }));

// ── CALLS ENDPOINT ───────────────────────────
app.post('/api/calls', async (req, res) => {
  const { dateFrom, dateTo, targets } = req.body;
  const targetNumbers = targets && targets.length ? targets : AA_TARGETS;

  const reportStart = `${dateFrom}T00:00:00`;
  const reportEnd   = `${dateTo}T23:59:59`;

  try {
    let allRecords = [];
    let offset = 0;
    const size = 1000;

    // Paginate through all Ringba results
    while (true) {
      const payload = {
        reportStart,
        reportEnd,
        filters: [
          {
            anyCondition: false,
            conditions: targetNumbers.map(num => ({
              column: 'targetPhoneNumber',
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
      const records = rbData.callLogs || rbData.records || rbData.data || [];
      allRecords = allRecords.concat(records);

      // If fewer results than page size, we've got everything
      if (records.length < size) break;
      offset += size;
    }

    // Aggregate stats
    const totalCalls     = allRecords.length;
    const connectedCalls = allRecords.filter(r =>
      r.callStatus === 'Completed' ||
      r.connectedCallCount > 0 ||
      r.converted === true ||
      r.hasConnected === true
    ).length;

    const durations = allRecords
      .map(r => r.callLengthInSeconds || r.duration || r.callLength || 0)
      .filter(d => d > 0);
    const avgDurationSec = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    res.json({ totalCalls, connectedCalls, avgDurationSec });
  } catch (err) {
    console.error('Ringba error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AA Health proxy on port ${PORT}`));
