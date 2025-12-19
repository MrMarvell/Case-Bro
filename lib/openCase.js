const crypto = require('crypto');
const config = require('./config');
const { db, nowIso } = require('./db');
const { sha256hex, rotateUserSeed } = require('./store');
const { parseGemsToCents, formatGems, masteryLevelFromXp, masteryGemBonusMult, clamp } = require('./economy');
const { addPoolProgress } = require('./pool');

const RARE_RARITIES = new Set(['Classified', 'Covert', 'Extraordinary']);

function hmacSha256Hex(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function rollToInt(hex, maxExclusive) {
  if (maxExclusive <= 0) return 0;
  const bi = BigInt('0x' + hex);
  return Number(bi % BigInt(maxExclusive));
}

function selectWeighted(rows, roll) {
  let acc = 0;
  for (const r of rows) {
    acc += r.weight;
    if (roll < acc) return r;
  }
  return rows[rows.length - 1];
}

function applyBrokenCaseWeights(rows, payload) {
  // Multiply rare items weights; keep integers
  const mult = Number(payload?.rare_weight_mult || 1);
  if (!Number.isFinite(mult) || mult <= 1) return rows;
  return rows.map(r => {
    const isRare = RARE_RARITIES.has(r.rarity);
    return { ...r, weight: isRare ? Math.max(1, Math.round(r.weight * mult)) : r.weight };
  });
}

function getCaseBySlug(slug) {
  return db.prepare('SELECT * FROM cases WHERE slug=? AND active=1').get(slug);
}

function getCaseRows(caseId) {
  return db.prepare(`
    SELECT ci.weight, i.id as item_id, i.name, i.rarity, i.image_url, i.price_cents
    FROM case_items ci
    JOIN items i ON i.id = ci.item_id
    WHERE ci.case_id=?
  `).all(caseId);
}

function getOrCreateMastery(userId, caseId) {
  const row = db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(userId, caseId);
  if (row) return row;
  db.prepare('INSERT INTO mastery(user_id,case_id,xp,level,updated_at) VALUES(?,?,?,?,?)')
    .run(userId, caseId, 0, 0, nowIso());
  return db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(userId, caseId);
}

function updateMastery(userId, caseId) {
  const m = getOrCreateMastery(userId, caseId);
  const newXp = (m.xp || 0) + 1;
  const newLevel = masteryLevelFromXp(newXp);
  db.prepare('UPDATE mastery SET xp=?, level=?, updated_at=? WHERE user_id=? AND case_id=?')
    .run(newXp, newLevel, nowIso(), userId, caseId);
  return db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(userId, caseId);
}

function computeCostCents(c, discount) {
  let casePrice = c.case_price_cents;
  let keyPrice = c.key_price_cents;

  const d = clamp(Number(discount) || 0, 0, 0.5);
  if (d > 0) {
    casePrice = Math.round(casePrice * (1 - d));
    keyPrice = Math.round(keyPrice * (1 - d));
  }

  return {
    casePrice,
    keyPrice,
    total: casePrice + keyPrice,
    discount: d,
  };
}


function ensureDailyCap(u, earnedCents, now = new Date()) {
  const dateKey = now.toISOString().slice(0, 10);
  let dailyEarned = u.daily_open_earned_cents || 0;
  if (u.daily_open_earned_date !== dateKey) {
    dailyEarned = 0;
    db.prepare('UPDATE users SET daily_open_earned_cents=?, daily_open_earned_date=? WHERE id=?')
      .run(0, dateKey, u.id);
  }
  const cap = parseGemsToCents(config.DAILY_OPEN_GEM_CAP);
  const remaining = Math.max(0, cap - dailyEarned);
  const allowed = Math.min(earnedCents, remaining);
  db.prepare('UPDATE users SET daily_open_earned_cents=daily_open_earned_cents+? WHERE id=?').run(allowed, u.id);
  return allowed;
}

function openCase({ userId, slug, clientSeed, brokenEvent, boostEvent }) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('not_logged_in');

  const c = getCaseBySlug(slug);
  if (!c) throw new Error('case_not_found');

  // modifiers
const modifiers = {};
const now = new Date();
let boostPayload = null;
if (boostEvent) {
  try {
    boostPayload = JSON.parse(boostEvent.payload_json);
    Object.assign(modifiers, boostPayload);
  } catch { /* ignore */ }
}
// Broken Case Hour applies only if this case is the broken one
if (brokenEvent) {
  try {
    const p = JSON.parse(brokenEvent.payload_json);
    if (p.case_id === c.id) modifiers.broken = p;
  } catch {}
}

// Combine discounts from boost + broken (cap at 50%)
let discount = 0;
if (boostPayload?.discount) discount += Number(boostPayload.discount);
if (modifiers.broken?.discount) discount += Number(modifiers.broken.discount);
discount = clamp(discount, 0, 0.5);

const cost = computeCostCents(c, discount);
// discount if any
  if (u.gems_cents < cost.total) throw new Error('not_enough_gems');

  // prepare RNG
  const rows0 = getCaseRows(c.id);
  if (!rows0.length) throw new Error('case_empty');

  let rows = rows0.map(r => ({ weight: r.weight, item_id: r.item_id, name: r.name, rarity: r.rarity, image_url: r.image_url, price_cents: r.price_cents }));
  if (modifiers.broken) rows = applyBrokenCaseWeights(rows, modifiers.broken);

  const totalWeight = rows.reduce((a, r) => a + (r.weight || 0), 0);
  const nonce = (u.nonce || 0) + 1;

  const modifiersHash = sha256hex(JSON.stringify({
    case: c.id,
    broken: modifiers.broken ? { rare_weight_mult: modifiers.broken.rare_weight_mult, discount: modifiers.broken.discount } : null,
    boost: boostPayload,
  }));

  const msg = `${clientSeed}:${nonce}:${c.id}:${modifiersHash}`;
  const randHex = hmacSha256Hex(u.server_seed, msg);
  const roll = rollToInt(randHex, totalWeight);
  const selected = selectWeighted(rows, roll);

  // compute earned gems
  const baseEarn = Math.floor((selected.price_cents || 0) * config.EARN_RATE);
  const mastery = getOrCreateMastery(u.id, c.id);
  const masteryMult = masteryGemBonusMult(mastery.level || 0);
  let earned = Math.floor(baseEarn * masteryMult);

  // boostPayload was parsed earlier
  if (boostPayload?.gem_earn_mult) earned = Math.floor(earned * Number(boostPayload.gem_earn_mult));

  // per-open cap
  const perOpenCap = parseGemsToCents(config.OPEN_GEM_CAP_PER_OPEN);
  earned = Math.min(earned, perOpenCap);

  // daily cap
  earned = ensureDailyCap(u, earned, now);

  // update user wallet and stats
  const newBalance = u.gems_cents - cost.total + earned;
  db.prepare('UPDATE users SET gems_cents=?, total_opens=total_opens+1 WHERE id=?').run(newBalance, u.id);

  // ledger
  db.prepare('INSERT INTO ledger(user_id,type,amount_cents,meta_json,created_at) VALUES(?,?,?,?,?)')
    .run(u.id, 'open_spend', -cost.total, JSON.stringify({ case: c.slug }), nowIso());
  db.prepare('INSERT INTO ledger(user_id,type,amount_cents,meta_json,created_at) VALUES(?,?,?,?,?)')
    .run(u.id, 'open_earn', earned, JSON.stringify({ item: selected.name }), nowIso());

  // record open and inventory
  const openInfo = db.prepare(`
    INSERT INTO opens(user_id,case_id,item_id,spent_cents,earned_cents,created_at,server_seed_hash,server_seed,client_seed,nonce,rng_roll,modifiers_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(u.id, c.id, selected.item_id, cost.total, earned, nowIso(), u.server_seed_hash, u.server_seed, clientSeed, nonce, roll, JSON.stringify({ modifiersHash, modifiers }));

  db.prepare('INSERT INTO inventory(user_id,item_id,open_id,obtained_at) VALUES(?,?,?,?)')
    .run(u.id, selected.item_id, openInfo.lastInsertRowid, nowIso());

  // mastery update
  const masteryAfter = updateMastery(u.id, c.id);

  // pool progress
  const pool = addPoolProgress(cost.total);

  // rotate seed and reset nonce
  const next = rotateUserSeed(u.id);

  // also reset nonce explicitly (rotateUserSeed sets nonce=0)
  return {
    open_id: openInfo.lastInsertRowid,
    case: { slug: c.slug, name: c.name },
    item: { id: selected.item_id, name: selected.name, rarity: selected.rarity, image_url: selected.image_url, price_gems: formatGems(selected.price_cents) },
    spent_gems: formatGems(cost.total),
    earned_gems: formatGems(earned),
    balance_gems: formatGems(newBalance),
    reveal: {
      server_seed_hash: u.server_seed_hash,
      server_seed: u.server_seed,
      client_seed: clientSeed,
      nonce,
    },
    next_server_seed_hash: next.hash,
    mastery: { xp: masteryAfter.xp, level: masteryAfter.level },
    pool,
  };
}

module.exports = {
  openCase,
  getCaseBySlug,
  getCaseRows,
  getOrCreateMastery,
};
