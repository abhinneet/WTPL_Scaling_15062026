/**
 * routes/dashboard.js — Master dashboard summary data
 * GET /api/dashboard/summary
 */
const router = require('express').Router();
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
router.use(authenticate);

router.get('/summary', async (req, res) => {
  try {
    const [apps, geo, users, ads] = await Promise.all([
      query(`SELECT COUNT(*) AS live FROM state_apps WHERE status='live'`),
      query(`SELECT COUNT(*) AS active FROM geofences WHERE is_active=true`),
      query(`SELECT COUNT(*) AS total FROM users WHERE is_active=true`),
      query(`SELECT COUNT(*) AS live FROM ad_campaigns WHERE status='live'`)
    ]);

    const activeUsers = await query(`
      SELECT COALESCE(SUM(active_users),0) AS total FROM state_apps WHERE status='live'
    `);

    const pendingAssets = await query(`
      SELECT COUNT(*) AS pending FROM unity_assets WHERE status='review'
    `);

    res.json({
      live_apps       : parseInt(apps.rows[0].live),
      active_geofences: parseInt(geo.rows[0].active),
      user_accounts   : parseInt(users.rows[0].total),
      live_ad_campaigns: parseInt(ads.rows[0].live),
      active_students : parseInt(activeUsers.rows[0].total),
      pending_approvals: parseInt(pendingAssets.rows[0].pending)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Dashboard summary failed' });
  }
});

module.exports = router;
