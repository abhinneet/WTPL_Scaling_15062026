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

const axios = require('axios'); // Required to fetch the map data

// POST sync geofence for state (Issue 8)
router.post('/sync-geojson/state/:stateCode', require('../middleware/auth').authenticate, async (req, res) => {
  const { stateCode } = req.params;
  
  // Map state codes to OSM (OpenStreetMap) names for accurate boundary lookup
  const STATE_OSM_NAMES = {
    AP:'Andhra Pradesh', AR:'Arunachal Pradesh', AS:'Assam', BR:'Bihar',
    CT:'Chhattisgarh', GA:'Goa', GJ:'Gujarat', HR:'Haryana',
    HP:'Himachal Pradesh', JH:'Jharkhand', KA:'Karnataka', KL:'Kerala',
    MP:'Madhya Pradesh', MH:'Maharashtra', MN:'Manipur', ML:'Meghalaya',
    MZ:'Mizoram', NL:'Nagaland', OR:'Odisha', PB:'Punjab', RJ:'Rajasthan',
    SK:'Sikkim', TN:'Tamil Nadu', TS:'Telangana', TR:'Tripura',
    UP:'Uttar Pradesh', UK:'Uttarakhand', WB:'West Bengal',
    DL:'Delhi', JK:'Jammu and Kashmir', LA:'Ladakh', CH:'Chandigarh',
    PY:'Puducherry'
  };
  
  const stateName = STATE_OSM_NAMES[stateCode];
  if (!stateName) {
    return res.status(400).json({ error: `Unknown state code: ${stateCode}` });
  }
  
  try {
    // Step 1: Query Nominatim to get OSM relation ID for this state
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(stateName + ', India')}&format=json&limit=1&featuretype=state`;
    const nominatimRes = await axios.get(nominatimUrl, {
      headers: { 'User-Agent': 'MITRA-Dashboard/4.0 (contact@mitra.gov.in)' }
    });
    
    if (!nominatimRes.data || !nominatimRes.data.length) {
      return res.status(404).json({ error: `No boundary found for ${stateName}` });
    }
    
    const place = nominatimRes.data[0];
    const lat   = parseFloat(place.lat);
    const lon   = parseFloat(place.lon);
    const osmId = place.osm_id;
    
    // Step 2: Upsert the geofence record in the DB
    const db = require('../db');
    await db.query(
      `INSERT INTO geofences (state_code, state_name, lat, lng, osm_id, admin_level, is_active, synced_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
       ON CONFLICT (state_code) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, osm_id = EXCLUDED.osm_id,
             admin_level = EXCLUDED.admin_level, is_active = true, synced_at = NOW()`,
      [stateCode, stateName, lat, lon, osmId, 'admin_level 4']
    );
    
    return res.json({
      success:     true,
      state_code:  stateCode,
      state_name:  stateName,
      lat,
      lon,
      osm_id:      osmId,
      admin_level: 'admin_level 4',
      message:     `Geofence synced for ${stateName}`
    });
    
  } catch (err) {
    console.error('Geofence sync error:', err.message);
    
    // Graceful fallback: save with approximate center coordinates
    const FALLBACK_COORDS = {
      GJ: { lat: 22.3085, lon: 72.1362 }, MH: { lat: 19.6633, lon: 75.3131 },
      UP: { lat: 26.8467, lon: 80.9462 }, RJ: { lat: 27.0238, lon: 74.2179 },
      TN: { lat: 11.1271, lon: 78.6569 }, KA: { lat: 15.3173, lon: 75.7139 },
      WB: { lat: 22.9868, lon: 87.8550 }, MP: { lat: 22.9734, lon: 78.6569 },
      AP: { lat: 15.9129, lon: 79.7400 }, TS: { lat: 17.1232, lon: 79.2088 },
    };
    
    const fallback = FALLBACK_COORDS[stateCode];
    if (fallback) {
      try {
        const db = require('../db');
        await db.query(
          `INSERT INTO geofences (state_code, state_name, lat, lng, admin_level, is_active, synced_at, created_at)
           VALUES ($1, $2, $3, $4, 'admin_level 4', true, NOW(), NOW())
           ON CONFLICT (state_code) DO UPDATE
             SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, is_active = true, synced_at = NOW()`,
          [stateCode, stateName, fallback.lat, fallback.lon]
        );
        return res.json({ success: true, state_code: stateCode, state_name: stateName,
          lat: fallback.lat, lon: fallback.lon, admin_level: 'admin_level 4',
          message: `Geofence synced (fallback coordinates) for ${stateName}` });
      } catch (dbErr) {
        return res.status(500).json({ error: 'Database error during fallback sync' });
      }
    }
    
    return res.status(502).json({ error: 'Could not reach Nominatim and no fallback available' });
  }
});


module.exports = router;
module.exports.INDIA_LANGUAGES = INDIA_LANGUAGES;
