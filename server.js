// case-bros custom server (Express + Next.js + Steam OpenID)
const express = require('express');
const next = require('next');
const cookieSession = require('cookie-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const config = require('./lib/config');
const { db, nowIso } = require('./lib/db');
require('./scripts/init-db'); // ensure schema

const { upsertUserFromSteamProfile, publicUserView } = require('./lib/store');
const { startSchedulers, getBrokenCaseEvent, getBrosBoostEvent } = require('./lib/events');
const { getPool } = require('./lib/pool');
const { openCase } = require('./lib/openCase');
const { claimStreak } = require('./lib/streak');
const { listInventory, sellItem } = require('./lib/inventory');
const { getLeaderboard } = require('./lib/leaderboard');
const { listGiveaways, getGiveaway, enterGiveaway } = require('./lib/giveaways');
const { verifyOpen } = require('./lib/verify');
const { parseGemsToCents } = require('./lib/economy');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

function requireAuth(req, res, nextFn) {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  return nextFn();
}

function requireAdmin(req, res, nextFn) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'forbidden' });
  return nextFn();
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function upsertCaseWithItems(payload) {
  // payload: {slug,name,casePrice,keyPrice,imageUrl,items:[{name,rarity,price,weight,imageUrl}]}
  const c = db.prepare(`
    INSERT INTO cases(slug,name,image_url,case_price_cents,key_price_cents,active)
    VALUES(?,?,?,?,?,1)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name,
      image_url=excluded.image_url,
      case_price_cents=excluded.case_price_cents,
      key_price_cents=excluded.key_price_cents,
      active=1
  `);
  c.run(
    payload.slug,
    payload.name,
    payload.imageUrl || null,
    parseGemsToCents(payload.casePrice),
    parseGemsToCents(payload.keyPrice),
  );
  const row = db.prepare('SELECT * FROM cases WHERE slug=?').get(payload.slug);

  for (const it of (payload.items || [])) {
    const existing = db.prepare('SELECT * FROM items WHERE name=? AND rarity=?').get(it.name, it.rarity);
    let itemRow = existing;
    if (!existing) {
      const info = db.prepare('INSERT INTO items(name,rarity,image_url,price_cents) VALUES(?,?,?,?)')
        .run(it.name, it.rarity, it.imageUrl || null, parseGemsToCents(it.price));
      itemRow = db.prepare('SELECT * FROM items WHERE id=?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE items SET image_url=?, price_cents=? WHERE id=?')
        .run(it.imageUrl || existing.image_url, parseGemsToCents(it.price), existing.id);
    }

    db.prepare(`
      INSERT INTO case_items(case_id,item_id,weight)
      VALUES(?,?,?)
      ON CONFLICT(case_id,item_id) DO UPDATE SET weight=excluded.weight
    `).run(row.id, itemRow.id, Math.max(1, Math.floor(Number(it.weight) || 1)));
  }

  return row;
}

app.prepare().then(() => {
  const server = express();

  // IMPORTANT for Render/HTTPS proxy so secure cookies work
  server.set('trust proxy', 1);

  server.use(cookieSession({
    name: 'casebros',
    keys: [config.SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    secure: !dev,
  }));

  // ✅ FIX: cookie-session doesn't implement regenerate/save but Passport expects them
  server.use((req, res, nextFn) => {
    if (req.session && typeof req.session.regenerate !== 'function') {
      req.session.regenerate = (cb) => cb && cb();
    }
    if (req.session && typeof req.session.save !== 'function') {
      req.session.save = (cb) => cb && cb();
    }
    nextFn();
  });

  server.use(passport.initialize());
  server.use(passport.session());

  passport.serializeUser((user, done) => done(null, user.steam_id));
  passport.deserializeUser((steamId, done) => {
    const u = db.prepare('SELECT * FROM users WHERE steam_id=?').get(steamId);
    done(null, u ? publicUserView(u) : null);
  });

  if (!config.STEAM_API_KEY) {
    console.warn('⚠️  STEAM_API_KEY is empty. Steam login will not work until you set it in .env');
  }

  passport.use(new SteamStrategy({
    returnURL: `${config.BASE_URL}/auth/steam/return`,
    realm: config.BASE_URL,
    apiKey: config.STEAM_API_KEY || 'missing',
  }, (identifier, profile, done) => {
    try {
      const u = upsertUserFromSteamProfile(profile);
      return done(null, publicUserView(u));
    } catch (e) {
      console.error('steam auth error', e);
      return done(e);
    }
  }));

  server.use(express.json({ limit: '2mb' }));

  // Auth routes
  server.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));
  server.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
  });

  server.get('/auth/logout', (req, res) => {
    req.logout(() => {
      res.redirect('/');
    });
  });

  // API
  server.get('/api/state', (req, res) => {
    const broken = getBrokenCaseEvent(new Date());
    const boost = getBrosBoostEvent(new Date());
    const pool = getPool();
    res.json({
      me: req.user || null,
      events: {
        broken_case: broken ? safeJsonParse(broken.payload_json, null) : null,
        bros_boost: boost ? safeJsonParse(boost.payload_json, null) : null,
        broken_window: broken ? { start_at: broken.start_at, end_at: broken.end_at } : null,
        boost_window: boost ? { start_at: boost.start_at, end_at: boost.end_at } : null,
      },
      pool,
    });
  });

  server.get('/api/cases', (req, res) => {
    const rows = db.prepare('SELECT * FROM cases WHERE active=1 ORDER BY name ASC').all();
    const broken = getBrokenCaseEvent(new Date());
    const brokenPayload = broken ? safeJsonParse(broken.payload_json, null) : null;
    res.json(rows.map(c => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      image_url: c.image_url,
      case_price_gems: (c.case_price_cents / 100).toFixed(2),
      key_price_gems: (c.key_price_cents / 100).toFixed(2),
      is_broken: brokenPayload?.case_id === c.id,
    })));
  });

  server.get('/api/cases/:slug', (req, res) => {
    const c = db.prepare('SELECT * FROM cases WHERE slug=? AND active=1').get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'not_found' });
    const items = db.prepare(`
      SELECT ci.weight, i.id, i.name, i.rarity, i.image_url, i.price_cents
      FROM case_items ci JOIN items i ON i.id = ci.item_id
      WHERE ci.case_id=?
      ORDER BY i.price_cents ASC
    `).all(c.id).map(r => ({
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      image_url: r.image_url,
      price_gems: (r.price_cents / 100).toFixed(2),
      weight: r.weight,
    }));

    let mastery = null;
    if (req.user) {
      const m = db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(req.user.id, c.id);
      mastery = m || { xp: 0, level: 0 };
    }

    res.json({
      id: c.id,
      slug: c.slug,
      name: c.name,
      image_url: c.image_url,
      case_price_gems: (c.case_price_cents / 100).toFixed(2),
      key_price_gems: (c.key_price_cents / 100).toFixed(2),
      items,
      mastery,
    });
  });

  server.post('/api/open', requireAuth, (req, res) => {
    const { slug, clientSeed } = req.body || {};
    if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'bad_slug' });
    if (!clientSeed || typeof clientSeed !== 'string' || clientSeed.length < 3 || clientSeed.length > 64) {
      return res.status(400).json({ error: 'bad_client_seed' });
    }
    const broken = getBrokenCaseEvent(new Date());
    const boost = getBrosBoostEvent(new Date());
    try {
      const result = openCase({ userId: req.user.id, slug, clientSeed, brokenEvent: broken, boostEvent: boost });
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      req.user.server_seed_hash = u.server_seed_hash;
      req.user.streak_day = u.streak_day;
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.post('/api/streak/claim', requireAuth, (req, res) => {
    const boost = getBrosBoostEvent(new Date());
    try {
      const result = claimStreak(req.user.id, boost);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      req.user.streak_day = u.streak_day;
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.get('/api/inventory', requireAuth, (req, res) => {
    res.json({ items: listInventory(req.user.id) });
  });

  server.post('/api/inventory/sell', requireAuth, (req, res) => {
    const { inventoryId } = req.body || {};
    try {
      const result = sellItem(req.user.id, inventoryId);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.get('/api/leaderboard', (req, res) => {
    res.json({ rows: getLeaderboard(50) });
  });

  server.get('/api/giveaways', (req, res) => {
    const pool = getPool();
    res.json({ pool, giveaways: listGiveaways(req.user?.id, pool.tier) });
  });

  server.get('/api/giveaways/:id', (req, res) => {
    const g = getGiveaway(req.params.id);
    if (!g) return res.status(404).json({ error: 'not_found' });
    const pool = getPool();
    let myEntries = 0;
    if (req.user) {
      const row = db.prepare('SELECT entries FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').get(g.id, req.user.id);
      myEntries = row ? row.entries : 0;
    }
    res.json({
      giveaway: { ...g, locked: pool.tier < g.tier_required },
      pool,
      my_entries: myEntries,
    });
  });

  server.post('/api/giveaways/:id/enter', requireAuth, (req, res) => {
    const pool = getPool();
    const entries = req.body?.entries;
    try {
      const result = enterGiveaway(req.user.id, Number(req.params.id), entries, pool.tier);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      req.user.gems = (u.gems_cents / 100).toFixed(2);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  server.get('/api/provably-fair/:openId', (req, res) => {
    const v = verifyOpen(req.params.openId);
    res.json(v);
  });

  // Admin
  server.post('/api/admin/import', requireAuth, requireAdmin, (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'bad_payload' });

    const cases = payload.cases;
    if (!Array.isArray(cases) || cases.length === 0) return res.status(400).json({ error: 'missing_cases' });

    const inserted = [];
    const errors = [];

    for (const c of cases) {
      try {
        if (!c.slug || !c.name || !c.casePrice || !c.keyPrice) throw new Error('missing_fields');
        inserted.push(upsertCaseWithItems(c));
      } catch (e) {
        errors.push({ slug: c?.slug, error: String(e.message || e) });
      }
    }

    res.json({ ok: true, inserted: inserted.length, errors });
  });

  server.post('/api/admin/giveaways', requireAuth, requireAdmin, (req, res) => {
    const { title, description, tier_required, prize_text, starts_at, ends_at } = req.body || {};
    if (!title || !prize_text || !starts_at || !ends_at) return res.status(400).json({ error: 'missing_fields' });

    db.prepare(`
      INSERT INTO giveaways(title,description,tier_required,prize_text,starts_at,ends_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(title, description || '', Math.max(0, Math.floor(Number(tier_required) || 0)), prize_text, starts_at, ends_at, 'active', nowIso());

    res.json({ ok: true });
  });

  // Next.js handler
  server.all('*', (req, res) => handle(req, res));

  // start schedulers
  startSchedulers();

  server.listen(config.PORT, () => {
    console.log(`✅ case-bros running on ${config.BASE_URL} (port ${config.PORT})`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
