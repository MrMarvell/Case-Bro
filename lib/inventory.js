const { db, nowIso } = require('./db');
const { formatGems } = require('./economy');

const SELL_RATE = 0.60; // 60% of indexed price

function listInventory(userId) {
  return db.prepare(`
    SELECT inv.id as inventory_id, inv.obtained_at, inv.is_sold, inv.sold_at, inv.sold_for_cents,
           i.id as item_id, i.name, i.rarity, i.image_url, i.price_cents
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.user_id=?
    ORDER BY inv.id DESC
  `).all(userId).map(r => ({
    inventory_id: r.inventory_id,
    obtained_at: r.obtained_at,
    is_sold: !!r.is_sold,
    sold_at: r.sold_at,
    sold_for_gems: r.sold_for_cents != null ? formatGems(r.sold_for_cents) : null,
    item: { id: r.item_id, name: r.name, rarity: r.rarity, image_url: r.image_url, price_gems: formatGems(r.price_cents) },
  }));
}

function sellItem(userId, inventoryId) {
  const inv = db.prepare(`
    SELECT inv.*, i.price_cents, i.name
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.id=? AND inv.user_id=?
  `).get(inventoryId, userId);
  if (!inv) throw new Error('not_found');
  if (inv.is_sold) throw new Error('already_sold');

  const sellFor = Math.floor(inv.price_cents * SELL_RATE);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const newBalance = u.gems_cents + sellFor;

  db.prepare('UPDATE users SET gems_cents=? WHERE id=?').run(newBalance, userId);
  db.prepare('UPDATE inventory SET is_sold=1, sold_at=?, sold_for_cents=? WHERE id=?').run(nowIso(), sellFor, inventoryId);

  db.prepare('INSERT INTO ledger(user_id,type,amount_cents,meta_json,created_at) VALUES(?,?,?,?,?)')
    .run(userId, 'inventory_sell', sellFor, JSON.stringify({ inventoryId, item: inv.name }), nowIso());

  return { sold_for_gems: formatGems(sellFor), balance_gems: formatGems(newBalance) };
}

module.exports = { listInventory, sellItem, SELL_RATE };
