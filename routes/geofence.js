/**
 * routes/geofence.js — Geofence management with Nominatim OpenStreetMap GeoJSON
 *
 * Boundaries are fetched from Nominatim OSM for Indian States (admin_level=4)
 * and Districts (admin_level=5) and stored/cached in the DB.
 */

const router = require('express').Router();
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

// ── Nominatim GeoJSON fetch helper ────────────────────────────────────────────
function fetchNominatimBoundary(name, adminLevel = 4, context = '') {
  return new Promise((resolve, reject) => {
    const searchQuery = context
      ? encodeURIComponent(`${name}, ${context}, India`)
      : encodeURIComponent(`${name}, India`);

    const url = `https://nominatim.openstreetmap.org/search?` +
      `q=${searchQuery}&countrycodes=in&polygon_geojson=1&format=json&limit=10`;

    https.get(url, {
      headers: {
        'User-Agent': 'MITRA-Dashboard/2.0 (gov-school-platform; admin@mitra.edu.in)',
        'Accept-Language': 'en'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          const match = results.find(r =>
            r.geojson &&
            ['Polygon', 'MultiPolygon'].includes(r.geojson.type) &&
            r.class === 'boundary' && r.type === 'administrative'
          ) || results.find(r =>
            r.geojson && ['Polygon', 'MultiPolygon'].includes(r.geojson.type)
          );
          resolve(match ? {
            geojson: match.geojson,
            nominatim_id: parseInt(match.osm_id) || null,
            display_name: match.display_name
          } : null);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// GET all geofences
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT g.*, (g.geojson IS NOT NULL) AS has_geojson, u.full_name AS created_by_name
      FROM geofences g LEFT JOIN users u ON u.id=g.created_by
      ORDER BY g.state, g.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to list geofences' }); }
});

// POST create geofence — auto-fetches Nominatim boundary
router.post('/', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const {
      name, state, district,
      radius_km = 50, language_lock = 'Follow User Setting',
      offline_only = false, ar_modules = [],
      auto_fetch_boundary = true
    } = req.body;
    if (!name || !state) return res.status(400).json({ error: 'name and state required' });

    const adminLevel = district ? 5 : 4;
    let geojson = null, nominatim_id = null;

    if (auto_fetch_boundary) {
      try {
        const geo = await fetchNominatimBoundary(district || state, adminLevel, district ? state : '');
        if (geo) { geojson = JSON.stringify(geo.geojson); nominatim_id = geo.nominatim_id; }
      } catch (e) { console.warn('[Geofence] Nominatim fetch skipped:', e.message); }
    }

    const result = await query(`
      INSERT INTO geofences (id,name,state,district,radius_km,language_lock,offline_only,ar_modules,geojson,nominatim_id,admin_level,last_geo_sync,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${geojson ? 'NOW()' : 'NULL'},$12) RETURNING *
    `, [uuidv4(), name, state, district||null, radius_km, language_lock, offline_only, ar_modules, geojson, nominatim_id, adminLevel, req.user.id]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create geofence', detail: err.message });
  }
});

// PUT update geofence
router.put('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const { name, radius_km, is_active, language_lock, offline_only, ar_modules, district } = req.body;
    const result = await query(`
      UPDATE geofences SET
        name=COALESCE($1,name), radius_km=COALESCE($2,radius_km),
        is_active=COALESCE($3,is_active), language_lock=COALESCE($4,language_lock),
        offline_only=COALESCE($5,offline_only), ar_modules=COALESCE($6,ar_modules),
        district=COALESCE($7,district), updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [name, radius_km, is_active, language_lock, offline_only, ar_modules, district, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to update geofence' }); }
});

// DELETE geofence
router.delete('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    await query('DELETE FROM geofences WHERE id=$1', [req.params.id]);
    res.json({ message: 'Geofence deleted' });
  } catch (err) { res.status(500).json({ error: 'Failed to delete geofence' }); }
});

// POST sync Nominatim boundary for existing geofence
router.post('/:id/sync-boundary', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const gf = await query('SELECT * FROM geofences WHERE id=$1', [req.params.id]);
    if (!gf.rows.length) return res.status(404).json({ error: 'Not found' });
    const fence = gf.rows[0];
    const adminLevel = fence.district ? 5 : 4;
    const geo = await fetchNominatimBoundary(fence.district || fence.state, adminLevel, fence.district ? fence.state : '');
    if (!geo) return res.status(404).json({ error: `No Nominatim polygon found for "${fence.district || fence.state}"` });
    const updated = await query(`
      UPDATE geofences SET geojson=$1, nominatim_id=$2, admin_level=$3, last_geo_sync=NOW(), updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [JSON.stringify(geo.geojson), geo.nominatim_id, adminLevel, req.params.id]);
    res.json({ success: true, geofence: updated.rows[0], nominatim_display: geo.display_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Boundary sync failed', detail: err.message });
  }
});

// GET check point against active geofences (ray-casting)
router.get('/check-point', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const fences = await query('SELECT id,name,state,district,geojson FROM geofences WHERE is_active=true AND geojson IS NOT NULL');
    const matches = fences.rows.filter(f => pointInGeoJSON(parseFloat(lat), parseFloat(lng), f.geojson))
      .map(f => ({ id: f.id, name: f.name, state: f.state, district: f.district }));
    res.json({ lat: parseFloat(lat), lng: parseFloat(lng), matches });
  } catch (err) { res.status(500).json({ error: 'Point check failed' }); }
});

function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj-xi)*(lat-yi)/(yj-yi))+xi)) inside = !inside;
  }
  return inside;
}

function pointInGeoJSON(lat, lng, geojson) {
  if (!geojson) return false;
  const g = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
  if (g.type === 'Polygon') return pointInPolygon(lat, lng, g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.some(p => pointInPolygon(lat, lng, p[0]));
  return false;
}

module.exports = router;
