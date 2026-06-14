/**
 * routes/locations.js
 * Serves official India states & districts with Nominatim OpenStreetMap GeoJSON polygons.
 * Used by all dropdowns, geofencing, quiz targeting, and analytics filters across the dashboard.
 *
 * GET  /api/locations/states               — list all states/UTs
 * GET  /api/locations/districts/:stateCode — list districts for a state
 * GET  /api/locations/languages            — list Indian languages
 * POST /api/locations/sync-geojson/state/:stateCode   — fetch & cache GeoJSON for a state
 * POST /api/locations/sync-geojson/district/:districtId — fetch & cache GeoJSON for a district
 * POST /api/locations/sync-all             — bulk sync all GeoJSON (background job)
 */

const router = require('express').Router();
const https  = require('https');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

// ── Official Indian Languages (22 Scheduled + major regional) ─────────────────
const INDIA_LANGUAGES = [
  'Assamese','Bengali','Bodo','Dogri','Gujarati','Hindi','Kannada','Kashmiri',
  'Konkani','Maithili','Malayalam','Manipuri','Marathi','Nepali','Odia',
  'Punjabi','Sanskrit','Santali','Sindhi','Tamil','Telugu','Urdu',
  'English','Bhili','Gondi','Tulu','Rajasthani','Chhattisgarhi','Haryanvi',
  'Bhojpuri','Magahi','Awadhi','Bundeli','Garhwali','Kumaoni',
];

// ── Nominatim OpenStreetMap API helper ────────────────────────────────────────
/**
 * Fetch GeoJSON polygon for an Indian administrative boundary.
 * admin_level 4 = States/UTs
 * admin_level 5 = Districts
 * Specifies country=India to ensure correct results.
 */
function fetchNominatimGeoJSON(name, adminLevel) {
  return new Promise((resolve, reject) => {
    // Use Nominatim search with country=India and polygon_geojson=1
    const q = encodeURIComponent(name);
    const url = `https://nominatim.openstreetmap.org/search?` +
      `q=${q}&` +
      `country=India&` +
      `featuretype=settlement&` +
      `addressdetails=1&` +
      `polygon_geojson=1&` +
      `format=json&` +
      `limit=5`;

    const options = {
      headers: {
        'User-Agent': 'MITRA-Dashboard/2.0 (government-school-platform; contact@mitra.gov.in)',
        'Accept-Language': 'en'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          // Filter by admin_level if available, prefer polygon/multipolygon
          const match = results.find(r =>
            r.geojson &&
            ['Polygon','MultiPolygon'].includes(r.geojson.type) &&
            (r.address?.country === 'India' || r.address?.country_code === 'in') &&
            (r.class === 'boundary' || r.type === 'administrative')
          ) || results.find(r =>
            r.geojson && ['Polygon','MultiPolygon'].includes(r.geojson.type)
          );

          if (match) {
            resolve({
              geojson: match.geojson,
              nominatim_id: parseInt(match.osm_id) || null,
              display_name: match.display_name
            });
          } else {
            resolve(null); // No polygon found — not a hard error
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Dedicated Nominatim lookup using relation-based boundary search
 * More accurate for administrative boundaries
 */
function fetchNominatimBoundary(name, adminLevel, countryCode = 'in') {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(`${name}, India`);
    const url = `https://nominatim.openstreetmap.org/search?` +
      `q=${q}&` +
      `countrycodes=${countryCode}&` +
      `polygon_geojson=1&` +
      `format=json&` +
      `featuretype=country,state,city,settlement&` +
      `limit=10`;

    const options = {
      headers: {
        'User-Agent': 'MITRA-Dashboard/2.0 (government-school-platform)',
        'Accept-Language': 'en'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          const match = results.find(r =>
            r.geojson && ['Polygon','MultiPolygon'].includes(r.geojson.type)
          );
          if (match) {
            resolve({
              geojson: match.geojson,
              nominatim_id: parseInt(match.osm_id) || null
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ── Rate-limit helper (Nominatim: max 1 req/sec) ──────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES (auth required but no special perm)
// ─────────────────────────────────────────────────────────────────────────────

router.use(authenticate);

// GET all states/UTs
router.get('/states', async (req, res) => {
  try {
    const result = await query(`
      SELECT id, code, name, region, capital,
             (geojson IS NOT NULL) AS has_geojson,
             last_geo_sync
      FROM india_states
      ORDER BY name
    `);
    res.json(result.rows);
  } catch (err) {
    // Fallback: return static data if DB table doesn't exist yet
    res.json(STATIC_STATES_FALLBACK);
  }
});

// GET districts for a state (by code)
router.get('/districts/:stateCode', async (req, res) => {
  try {
    const result = await query(`
      SELECT d.id, d.name, d.district_code,
             (d.geojson IS NOT NULL) AS has_geojson
      FROM india_districts d
      WHERE d.state_code = $1
      ORDER BY d.name
    `, [req.params.stateCode.toUpperCase()]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch districts', detail: err.message });
  }
});

// GET all districts (for preloading)
router.get('/districts', async (req, res) => {
  try {
    const result = await query(`
      SELECT d.id, d.state_code, d.name,
             s.name AS state_name
      FROM india_districts d
      JOIN india_states s ON s.code = d.state_code
      ORDER BY s.name, d.name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch districts' });
  }
});

// GET official Indian languages
router.get('/languages', (req, res) => {
  res.json(INDIA_LANGUAGES);
});

// GET GeoJSON for a specific state
router.get('/geojson/state/:code', async (req, res) => {
  try {
    const result = await query(
      'SELECT geojson, nominatim_id, name FROM india_states WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'State not found' });
    const row = result.rows[0];
    if (!row.geojson) return res.status(404).json({ error: 'GeoJSON not yet synced for this state' });
    res.json({ name: row.name, nominatim_id: row.nominatim_id, geojson: row.geojson });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch state GeoJSON' });
  }
});

// GET GeoJSON for a specific district
router.get('/geojson/district/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT d.geojson, d.nominatim_id, d.name, s.name AS state_name FROM india_districts d JOIN india_states s ON s.code=d.state_code WHERE d.id=$1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'District not found' });
    const row = result.rows[0];
    if (!row.geojson) return res.status(404).json({ error: 'GeoJSON not yet synced for this district' });
    res.json({ name: row.name, state: row.state_name, nominatim_id: row.nominatim_id, geojson: row.geojson });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch district GeoJSON' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — GeoJSON sync
// ─────────────────────────────────────────────────────────────────────────────

// POST sync GeoJSON for a single state
router.post('/sync-geojson/state/:code', requirePerm('perm_manage_geo'), async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const stateRow = await query('SELECT * FROM india_states WHERE code=$1', [code]);
    if (!stateRow.rows.length) return res.status(404).json({ error: 'State not found' });
    const state = stateRow.rows[0];

    // Use admin_level 4 for Indian states in Nominatim
    const geo = await fetchNominatimBoundary(state.name, 4);
    if (!geo) {
      return res.status(404).json({ error: `No GeoJSON polygon found for "${state.name}"` });
    }

    await query(`
      UPDATE india_states SET geojson=$1, nominatim_id=$2, last_geo_sync=NOW()
      WHERE code=$3
    `, [JSON.stringify(geo.geojson), geo.nominatim_id, code]);

    res.json({ success: true, state: state.name, nominatim_id: geo.nominatim_id });
  } catch (err) {
    res.status(500).json({ error: 'GeoJSON sync failed', detail: err.message });
  }
});

// POST sync GeoJSON for a single district
router.post('/sync-geojson/district/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const distRow = await query(
      'SELECT d.*, s.name AS state_name FROM india_districts d JOIN india_states s ON s.code=d.state_code WHERE d.id=$1',
      [req.params.id]
    );
    if (!distRow.rows.length) return res.status(404).json({ error: 'District not found' });
    const dist = distRow.rows[0];

    // Search "District, State, India" for better accuracy
    const geo = await fetchNominatimBoundary(`${dist.name} district ${dist.state_name}`, 5);
    if (!geo) {
      return res.status(404).json({ error: `No GeoJSON found for "${dist.name}, ${dist.state_name}"` });
    }

    await query(`
      UPDATE india_districts SET geojson=$1, nominatim_id=$2, last_geo_sync=NOW()
      WHERE id=$3
    `, [JSON.stringify(geo.geojson), geo.nominatim_id, req.params.id]);

    res.json({ success: true, district: dist.name, state: dist.state_name });
  } catch (err) {
    res.status(500).json({ error: 'GeoJSON sync failed', detail: err.message });
  }
});

// POST sync all states — runs async (returns job status immediately)
router.post('/sync-all', requirePerm('perm_manage_geo'), async (req, res) => {
  const { type = 'states' } = req.body; // 'states' or 'districts'

  // Return immediately, run in background
  res.json({
    message: `GeoJSON sync started for all ${type}. This runs in the background and may take several minutes due to Nominatim rate limits (1 req/sec).`,
    status: 'running'
  });

  // Background async sync
  (async () => {
    try {
      if (type === 'states') {
        const states = await query('SELECT code, name FROM india_states WHERE geojson IS NULL');
        for (const state of states.rows) {
          try {
            const geo = await fetchNominatimBoundary(state.name, 4);
            if (geo) {
              await query(
                'UPDATE india_states SET geojson=$1, nominatim_id=$2, last_geo_sync=NOW() WHERE code=$3',
                [JSON.stringify(geo.geojson), geo.nominatim_id, state.code]
              );
              console.log(`[GeoSync] ✅ State: ${state.name}`);
            } else {
              console.log(`[GeoSync] ⚠️  No polygon for state: ${state.name}`);
            }
          } catch (e) {
            console.error(`[GeoSync] ❌ Failed state ${state.name}:`, e.message);
          }
          await sleep(1100); // Nominatim 1 req/sec limit
        }
      } else {
        const districts = await query(`
          SELECT d.id, d.name, s.name AS state_name
          FROM india_districts d JOIN india_states s ON s.code=d.state_code
          WHERE d.geojson IS NULL
          ORDER BY s.name, d.name
        `);
        for (const dist of districts.rows) {
          try {
            const geo = await fetchNominatimBoundary(`${dist.name} district ${dist.state_name}`, 5);
            if (geo) {
              await query(
                'UPDATE india_districts SET geojson=$1, nominatim_id=$2, last_geo_sync=NOW() WHERE id=$3',
                [JSON.stringify(geo.geojson), geo.nominatim_id, dist.id]
              );
              console.log(`[GeoSync] ✅ District: ${dist.name}, ${dist.state_name}`);
            } else {
              console.log(`[GeoSync] ⚠️  No polygon: ${dist.name}, ${dist.state_name}`);
            }
          } catch (e) {
            console.error(`[GeoSync] ❌ Failed district ${dist.name}:`, e.message);
          }
          await sleep(1100);
        }
      }
      console.log('[GeoSync] ✅ Bulk sync complete');
    } catch (err) {
      console.error('[GeoSync] Fatal error:', err);
    }
  })();
});

// ── Static fallback if DB not yet seeded ──────────────────────────────────────
const STATIC_STATES_FALLBACK = [
  { code:'AN',name:'Andaman and Nicobar Islands',region:'Island'},
  { code:'AP',name:'Andhra Pradesh',region:'South'},
  { code:'AR',name:'Arunachal Pradesh',region:'Northeast'},
  { code:'AS',name:'Assam',region:'Northeast'},
  { code:'BR',name:'Bihar',region:'East'},
  { code:'CH',name:'Chandigarh',region:'North'},
  { code:'CT',name:'Chhattisgarh',region:'Central'},
  { code:'DD',name:'Dadra and Nagar Haveli and Daman and Diu',region:'West'},
  { code:'DL',name:'Delhi',region:'North'},
  { code:'GA',name:'Goa',region:'West'},
  { code:'GJ',name:'Gujarat',region:'West'},
  { code:'HR',name:'Haryana',region:'North'},
  { code:'HP',name:'Himachal Pradesh',region:'North'},
  { code:'JK',name:'Jammu and Kashmir',region:'North'},
  { code:'JH',name:'Jharkhand',region:'East'},
  { code:'KA',name:'Karnataka',region:'South'},
  { code:'KL',name:'Kerala',region:'South'},
  { code:'LA',name:'Ladakh',region:'North'},
  { code:'LD',name:'Lakshadweep',region:'Island'},
  { code:'MP',name:'Madhya Pradesh',region:'Central'},
  { code:'MH',name:'Maharashtra',region:'West'},
  { code:'MN',name:'Manipur',region:'Northeast'},
  { code:'ML',name:'Meghalaya',region:'Northeast'},
  { code:'MZ',name:'Mizoram',region:'Northeast'},
  { code:'NL',name:'Nagaland',region:'Northeast'},
  { code:'OD',name:'Odisha',region:'East'},
  { code:'PY',name:'Puducherry',region:'South'},
  { code:'PB',name:'Punjab',region:'North'},
  { code:'RJ',name:'Rajasthan',region:'North'},
  { code:'SK',name:'Sikkim',region:'Northeast'},
  { code:'TN',name:'Tamil Nadu',region:'South'},
  { code:'TG',name:'Telangana',region:'South'},
  { code:'TR',name:'Tripura',region:'Northeast'},
  { code:'UP',name:'Uttar Pradesh',region:'North'},
  { code:'UK',name:'Uttarakhand',region:'North'},
  { code:'WB',name:'West Bengal',region:'East'},
];

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/locations/states/sync-status - Get sync status for all states
// ═══════════════════════════════════════════════════════════════════════════

router.get('/states/sync-status', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        code,
        name,
        geojson IS NOT NULL as has_geojson,
        last_geo_sync,
        CASE 
          WHEN geojson IS NOT NULL THEN true
          ELSE false
        END as is_synced
      FROM india_states
      ORDER BY name
    `);

    const syncStatus = {};
    result.rows.forEach(row => {
      syncStatus[row.code] = {
        name: row.name,
        is_synced: row.is_synced,
        last_synced: row.last_geo_sync,
        has_data: row.has_geojson
      };
    });

    res.json(syncStatus);
  } catch (err) {
    console.error('[states/sync-status]', err);
    res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

// NOTE: POST /sync-geojson/state/:code and POST /sync-geojson/district/:id
// are defined above (lines ~235 and ~260) using the native https helpers.
// No additional route needed here.

// ── Seed india_states table with all 36 Indian states/UTs ────────────────────
router.post('/seed-states', requirePerm('perm_manage_geo'), async (req, res) => {
  const STATES = [
    { code:'AN', name:'Andaman and Nicobar Islands', region:'Island',    capital:'Port Blair' },
    { code:'AP', name:'Andhra Pradesh',              region:'South',     capital:'Amaravati' },
    { code:'AR', name:'Arunachal Pradesh',           region:'Northeast', capital:'Itanagar' },
    { code:'AS', name:'Assam',                       region:'Northeast', capital:'Dispur' },
    { code:'BR', name:'Bihar',                       region:'East',      capital:'Patna' },
    { code:'CH', name:'Chandigarh',                  region:'North',     capital:'Chandigarh' },
    { code:'CT', name:'Chhattisgarh',                region:'Central',   capital:'Raipur' },
    { code:'DD', name:'Dadra and Nagar Haveli and Daman and Diu', region:'West', capital:'Daman' },
    { code:'DL', name:'Delhi',                       region:'North',     capital:'New Delhi' },
    { code:'GA', name:'Goa',                         region:'West',      capital:'Panaji' },
    { code:'GJ', name:'Gujarat',                     region:'West',      capital:'Gandhinagar' },
    { code:'HR', name:'Haryana',                     region:'North',     capital:'Chandigarh' },
    { code:'HP', name:'Himachal Pradesh',            region:'North',     capital:'Shimla' },
    { code:'JK', name:'Jammu and Kashmir',           region:'North',     capital:'Srinagar' },
    { code:'JH', name:'Jharkhand',                   region:'East',      capital:'Ranchi' },
    { code:'KA', name:'Karnataka',                   region:'South',     capital:'Bengaluru' },
    { code:'KL', name:'Kerala',                      region:'South',     capital:'Thiruvananthapuram' },
    { code:'LA', name:'Ladakh',                      region:'North',     capital:'Leh' },
    { code:'LD', name:'Lakshadweep',                 region:'Island',    capital:'Kavaratti' },
    { code:'MP', name:'Madhya Pradesh',              region:'Central',   capital:'Bhopal' },
    { code:'MH', name:'Maharashtra',                 region:'West',      capital:'Mumbai' },
    { code:'MN', name:'Manipur',                     region:'Northeast', capital:'Imphal' },
    { code:'ML', name:'Meghalaya',                   region:'Northeast', capital:'Shillong' },
    { code:'MZ', name:'Mizoram',                     region:'Northeast', capital:'Aizawl' },
    { code:'NL', name:'Nagaland',                    region:'Northeast', capital:'Kohima' },
    { code:'OD', name:'Odisha',                      region:'East',      capital:'Bhubaneswar' },
    { code:'PY', name:'Puducherry',                  region:'South',     capital:'Puducherry' },
    { code:'PB', name:'Punjab',                      region:'North',     capital:'Chandigarh' },
    { code:'RJ', name:'Rajasthan',                   region:'North',     capital:'Jaipur' },
    { code:'SK', name:'Sikkim',                      region:'Northeast', capital:'Gangtok' },
    { code:'TN', name:'Tamil Nadu',                  region:'South',     capital:'Chennai' },
    { code:'TG', name:'Telangana',                   region:'South',     capital:'Hyderabad' },
    { code:'TR', name:'Tripura',                     region:'Northeast', capital:'Agartala' },
    { code:'UP', name:'Uttar Pradesh',               region:'North',     capital:'Lucknow' },
    { code:'UK', name:'Uttarakhand',                 region:'North',     capital:'Dehradun' },
    { code:'WB', name:'West Bengal',                 region:'East',      capital:'Kolkata' },
  ];

  try {
    let inserted = 0, skipped = 0;
    for (const s of STATES) {
      const exists = await query('SELECT 1 FROM india_states WHERE code=$1', [s.code]);
      if (exists.rows.length) { skipped++; continue; }
      await query(
        'INSERT INTO india_states (code, name, region, capital) VALUES ($1, $2, $3, $4)',
        [s.code, s.name, s.region, s.capital]
      );
      inserted++;
    }
    res.json({ success: true, inserted, skipped, total: STATES.length });
  } catch (err) {
    // If the capital column doesn't exist, retry without it
    try {
      let inserted = 0, skipped = 0;
      for (const s of STATES) {
        const exists = await query('SELECT 1 FROM india_states WHERE code=$1', [s.code]);
        if (exists.rows.length) { skipped++; continue; }
        await query(
          'INSERT INTO india_states (code, name, region) VALUES ($1, $2, $3)',
          [s.code, s.name, s.region]
        );
        inserted++;
      }
      res.json({ success: true, inserted, skipped, total: STATES.length, note: 'inserted without capital column' });
    } catch (err2) {
      res.status(500).json({ error: 'Seed failed', detail: err2.message });
    }
  }
});


module.exports = router;
module.exports.INDIA_LANGUAGES = INDIA_LANGUAGES;
