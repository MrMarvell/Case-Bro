import Layout from '../../components/Layout';
import { getMe } from '../../lib/getMe';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';

function randomSeed() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function rarityColor(r) {
  const m = {
    'Mil-Spec': 'text-blue-300',
    'Restricted': 'text-purple-300',
    'Classified': 'text-pink-300',
    'Covert': 'text-red-300',
    'Extraordinary': 'text-yellow-300',
  };
  return m[r] || 'text-zinc-200';
}

export async function getServerSideProps(ctx) {
  const me = getMe(ctx);
  const { db } = require('../../lib/db');
  const { getBrokenCaseEvent, getBrosBoostEvent } = require('../../lib/events');

  const slug = ctx.params.slug;
  const c = db.prepare('SELECT * FROM cases WHERE slug=? AND active=1').get(slug);
  if (!c) return { notFound: true };

  const items = db.prepare(`
    SELECT ci.weight, i.id, i.name, i.rarity, i.image_url, i.price_cents
    FROM case_items ci JOIN items i ON i.id = ci.item_id
    WHERE ci.case_id=?
  `).all(c.id);

  let mastery = null;
  if (me) {
    mastery = db.prepare('SELECT * FROM mastery WHERE user_id=? AND case_id=?').get(me.id, c.id) || { xp: 0, level: 0 };
  }

  const broken = getBrokenCaseEvent(new Date());
  const boost = getBrosBoostEvent(new Date());
  let brokenPayload = null, boostPayload = null;
  try { brokenPayload = broken ? JSON.parse(broken.payload_json) : null; } catch {}
  try { boostPayload = boost ? JSON.parse(boost.payload_json) : null; } catch {}

  const isBroken = brokenPayload?.case_id === c.id;

  return {
    props: {
      me,
      caseData: {
        id: c.id,
        slug: c.slug,
        name: c.name,
        image_url: c.image_url,
        case_price_gems: (c.case_price_cents / 100).toFixed(2),
        key_price_gems: (c.key_price_cents / 100).toFixed(2),
        isBroken,
      },
      items: items.map(i => ({
        id: i.id,
        name: i.name,
        rarity: i.rarity,
        image_url: i.image_url,
        price_gems: (i.price_cents / 100).toFixed(2),
        weight: i.weight,
      })),
      mastery,
      events: {
        brokenPayload,
        brokenWindow: broken ? { start_at: broken.start_at, end_at: broken.end_at } : null,
        boostPayload,
        boostWindow: boost ? { start_at: boost.start_at, end_at: boost.end_at } : null,
      },
    }
  };
}

export default function CasePage({ me, caseData, items, mastery, events }) {
  const [clientSeed, setClientSeed] = useState(randomSeed());
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState(null);

  const sorted = useMemo(() => {
    return [...items].sort((a,b) => Number(a.price_gems) - Number(b.price_gems));
  }, [items]);

  const totalWeight = useMemo(() => items.reduce((a, x) => a + x.weight, 0), [items]);

  const odds = useMemo(() => {
    // group by rarity
    const m = {};
    for (const it of items) {
      m[it.rarity] = (m[it.rarity] || 0) + it.weight;
    }
    return Object.entries(m).map(([rarity, w]) => ({ rarity, pct: ((w/totalWeight)*100).toFixed(3) })).sort((a,b) => Number(b.pct)-Number(a.pct));
  }, [items, totalWeight]);

  const broken = events?.brokenPayload;
  const boost = events?.boostPayload;

  return (
    <Layout me={me} title={caseData.name}>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid gap-4">
          <div className="card">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="w-full sm:w-64 aspect-[3/2] rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900">
                {caseData.image_url ? <img alt={caseData.name} src={caseData.image_url} className="w-full h-full object-cover" /> : null}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="h2">{caseData.name}</div>
                    <div className="small">Case {caseData.case_price_gems} • Key {caseData.key_price_gems}</div>
                  </div>
                  {caseData.isBroken ? <span className="badge border-emerald-600 text-emerald-200">Broken</span> : null}
                </div>

                {(boost || (broken && caseData.isBroken)) ? (
                  <div className="mt-3 grid gap-2">
                    {boost ? (
                      <div className="badge">🎉 Bros Boost: +{Math.round((Number(boost.gem_earn_mult||1)-1)*100)}% gem earnings, +{Math.round((Number(boost.streak_mult||1)-1)*100)}% streak</div>
                    ) : null}
                    {broken && caseData.isBroken ? (
                      <div className="badge">⚡ Broken Case Hour: rare weights ×{broken.rare_weight_mult}{broken.discount ? `, ${Math.round(Number(broken.discount)*100)}% off` : ''}</div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 grid gap-2">
                  <div className="text-sm font-semibold">Client seed</div>
                  <input className="input" value={clientSeed} onChange={e => setClientSeed(e.target.value)} />
                  <div className="flex gap-2">
                    <button className="btn" onClick={() => setClientSeed(randomSeed())}>Randomize</button>
                    {me ? (
                      <button
                        className="btn btn-primary"
                        disabled={opening}
                        onClick={async () => {
                          setOpening(true);
                          setResult(null);
                          try {
                            const r = await fetch('/api/open', {
                              method: 'POST',
                              headers: { 'content-type':'application/json' },
                              body: JSON.stringify({ slug: caseData.slug, clientSeed }),
                            });
                            const j = await r.json();
                            if (j.error) alert(j.error);
                            else setResult(j);
                          } finally {
                            setOpening(false);
                          }
                        }}
                      >
                        {opening ? 'Opening...' : 'Open case'}
                      </button>
                    ) : (
                      <a className="btn btn-primary" href="/auth/steam">Sign in to open</a>
                    )}
                  </div>
                  <div className="text-xs text-zinc-400">
                    Your server seed hash (commit): <span className="text-zinc-200 font-mono">{me?.server_seed_hash || '—'}</span>
                  </div>
                </div>

                {result ? (
                  <div className="mt-4 p-3 rounded-lg border border-zinc-800 bg-zinc-900/40">
                    <div className="text-sm font-semibold">Result</div>
                    <div className="mt-2 flex items-center gap-3">
                      {result.item?.image_url ? <img alt={result.item.name} src={result.item.image_url} className="h-16 w-24 rounded border border-zinc-800 object-cover" /> : null}
                      <div>
                        <div className={`font-semibold ${rarityColor(result.item.rarity)}`}>{result.item.name}</div>
                        <div className="small">Item value: {result.item.price_gems} gems</div>
                        <div className="small">Spent: -{result.spent_gems} • Earned: +{result.earned_gems} • Balance: {result.balance_gems}</div>
                        <div className="text-xs text-zinc-400 mt-1">Mastery Lv {result.mastery.level} • XP {result.mastery.xp}</div>
                      </div>
                    </div>

                    <div className="mt-3 text-xs text-zinc-400">
                      Provably fair reveal: serverSeedHash {result.reveal.server_seed_hash} • serverSeed {result.reveal.server_seed} • nonce {result.reveal.nonce}
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">
                      Next serverSeedHash: <span className="font-mono text-zinc-200">{result.next_server_seed_hash}</span>
                    </div>

                    <div className="mt-2">
                      <a className="btn" href={`/provably-fair?openId=${result.open_id}`}>Verify this open</a>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-semibold">Items in this case</div>
                <div className="small">Prices are indexed (you can update them in Admin).</div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
              {sorted.map(it => (
                <div key={it.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  {it.image_url ? <img alt={it.name} src={it.image_url} className="h-12 w-20 rounded border border-zinc-800 object-cover" /> : null}
                  <div className="flex-1">
                    <div className={`text-sm font-semibold ${rarityColor(it.rarity)}`}>{it.name}</div>
                    <div className="text-xs text-zinc-400">Value {it.price_gems} • Weight {it.weight}</div>
                  </div>
                  <span className="badge">{it.rarity}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="card">
            <div className="font-semibold">🏆 Case Mastery</div>
            <div className="small">Opening this case increases mastery. Higher mastery gives a small gem bonus on opens.</div>
            <div className="mt-3 grid gap-2">
              <div className="text-sm">
                Level: <span className="font-semibold text-zinc-100">{mastery?.level || 0}</span>
              </div>
              <div className="text-sm">
                XP: <span className="font-semibold text-zinc-100">{mastery?.xp || 0}</span>
              </div>
              <div className="text-xs text-zinc-400">
                Bonus: +{Math.min(10, (mastery?.level || 0) * 1.2).toFixed(1)}% gem earnings on this case
              </div>
              <div className="text-xs text-zinc-500">
                (Configurable in code. Keep bonuses small to avoid gem inflation.)
              </div>
            </div>
          </div>

          <div className="card">
            <div className="font-semibold">Odds summary</div>
            <div className="small">Based on weights (before Broken Case modifiers).</div>
            <div className="mt-3 grid gap-2">
              {odds.map(o => (
                <div key={o.rarity} className="flex items-center justify-between text-sm">
                  <span className={rarityColor(o.rarity)}>{o.rarity}</span>
                  <span className="text-zinc-200 font-mono">{o.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="font-semibold">Support</div>
            <div className="small">Ads and donations keep case-bros running. Donations never affect odds or gems.</div>
            <a className="btn mt-3" href="/support">Support case-bros</a>
          </div>
        </div>
      </div>
    </Layout>
  );
}
