const { db, nowIso } = require('../lib/db');
const { parseGemsToCents } = require('../lib/economy');

function upsertCase(c) {
  const stmt = db.prepare(`
    INSERT INTO cases(slug,name,image_url,case_price_cents,key_price_cents,active)
    VALUES(@slug,@name,@image_url,@case_price_cents,@key_price_cents,@active)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name,
      image_url=excluded.image_url,
      case_price_cents=excluded.case_price_cents,
      key_price_cents=excluded.key_price_cents,
      active=excluded.active
  `);
  stmt.run(c);
  return db.prepare('SELECT * FROM cases WHERE slug=?').get(c.slug);
}

function insertItem(i) {
  const stmt = db.prepare(`
    INSERT INTO items(name,rarity,image_url,price_cents)
    VALUES(@name,@rarity,@image_url,@price_cents)
  `);
  const info = stmt.run(i);
  return db.prepare('SELECT * FROM items WHERE id=?').get(info.lastInsertRowid);
}

function linkCaseItem(caseId, itemId, weight) {
  db.prepare(`
    INSERT INTO case_items(case_id,item_id,weight)
    VALUES(?,?,?)
    ON CONFLICT(case_id,item_id) DO UPDATE SET weight=excluded.weight
  `).run(caseId, itemId, weight);
}

function run() {
  // Minimal demo dataset (you can import the full CS2 case list in Admin -> Import)
  const cases = [
    {
      slug: 'kilowatt-case',
      name: 'Kilowatt Case',
      image_url: 'https://placehold.co/600x400?text=Kilowatt+Case',
      case_price_cents: parseGemsToCents('1.00'),
      key_price_cents: parseGemsToCents('2.50'),
      active: 1,
    },
    {
      slug: 'revolution-case',
      name: 'Revolution Case',
      image_url: 'https://placehold.co/600x400?text=Revolution+Case',
      case_price_cents: parseGemsToCents('0.90'),
      key_price_cents: parseGemsToCents('2.50'),
      active: 1,
    },
    {
      slug: 'dreams-nightmares-case',
      name: 'Dreams & Nightmares Case',
      image_url: 'https://placehold.co/600x400?text=Dreams+%26+Nightmares',
      case_price_cents: parseGemsToCents('0.80'),
      key_price_cents: parseGemsToCents('2.50'),
      active: 1,
    },
  ];

  const createdCases = cases.map(upsertCase);

  // Create demo items (shared across cases)
  const demoItems = [
    { name: 'Glock-18 | Circuit', rarity: 'Mil-Spec', image_url: 'https://placehold.co/300x200?text=Glock', price_cents: parseGemsToCents('0.35') },
    { name: 'MP9 | Neon Grid', rarity: 'Mil-Spec', image_url: 'https://placehold.co/300x200?text=MP9', price_cents: parseGemsToCents('0.42') },
    { name: 'AK-47 | Static Shock', rarity: 'Restricted', image_url: 'https://placehold.co/300x200?text=AK-47', price_cents: parseGemsToCents('2.10') },
    { name: 'M4A1-S | Vapor', rarity: 'Restricted', image_url: 'https://placehold.co/300x200?text=M4A1-S', price_cents: parseGemsToCents('2.85') },
    { name: 'AWP | Night Bloom', rarity: 'Classified', image_url: 'https://placehold.co/300x200?text=AWP', price_cents: parseGemsToCents('12.00') },
    { name: 'Desert Eagle | Golden Hour', rarity: 'Classified', image_url: 'https://placehold.co/300x200?text=Deagle', price_cents: parseGemsToCents('14.50') },
    { name: 'Karambit | Hyperwave', rarity: 'Covert', image_url: 'https://placehold.co/300x200?text=Knife', price_cents: parseGemsToCents('190.00') },
    { name: 'Gloves | Ember', rarity: 'Extraordinary', image_url: 'https://placehold.co/300x200?text=Gloves', price_cents: parseGemsToCents('260.00') },
  ];

  // Only insert if items table is empty (so seeding is idempotent-ish)
  const itemCount = db.prepare('SELECT COUNT(*) as n FROM items').get().n;
  let items;
  if (itemCount === 0) {
    items = demoItems.map(insertItem);
  } else {
    items = db.prepare('SELECT * FROM items').all();
  }

  function pick(name) {
    const it = items.find(x => x.name === name);
    if (!it) throw new Error('Missing item: ' + name);
    return it;
  }

  // Weights: higher = more common. Sum doesn't matter; we normalize.
  const weights = [
    { name: 'Glock-18 | Circuit', w: 5000 },
    { name: 'MP9 | Neon Grid', w: 4200 },
    { name: 'AK-47 | Static Shock', w: 900 },
    { name: 'M4A1-S | Vapor', w: 850 },
    { name: 'AWP | Night Bloom', w: 120 },
    { name: 'Desert Eagle | Golden Hour', w: 110 },
    { name: 'Karambit | Hyperwave', w: 10 },
    { name: 'Gloves | Ember', w: 6 },
  ];

  for (const c of createdCases) {
    for (const w of weights) {
      linkCaseItem(c.id, pick(w.name).id, w.w);
    }
  }

  // Create one demo giveaway if empty
  const giveawayCount = db.prepare('SELECT COUNT(*) as n FROM giveaways').get().n;
  if (giveawayCount === 0) {
    const now = new Date();
    const starts = new Date(now.getTime() - 60 * 60 * 1000);
    const ends = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    db.prepare(`
      INSERT INTO giveaways(title,description,tier_required,prize_text,starts_at,ends_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      'Weekly Starter Giveaway',
      'A demo giveaway. Replace this with a real prize and publish official rules before going live.',
      0,
      'Example prize: $25 Steam Gift Card',
      starts.toISOString(),
      ends.toISOString(),
      'active',
      nowIso()
    );
  }

  console.log('Seed complete.');
  console.log('Tip: open /admin -> Import to add your full case catalog.');
}

run();
