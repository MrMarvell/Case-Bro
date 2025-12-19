import Layout from '../components/Layout';
import Link from 'next/link';
import { getMe } from '../lib/getMe';
import dayjs from 'dayjs';

export async function getServerSideProps(ctx) {
  const me = getMe(ctx);

  const { db } = require('../lib/db');
  const { getPool } = require('../lib/pool');
  const { getBrokenCaseEvent, getBrosBoostEvent } = require('../lib/events');

  const cases = db.prepare('SELECT * FROM cases WHERE active=1 ORDER BY name ASC').all();
  const broken = getBrokenCaseEvent(new Date());
  const boost = getBrosBoostEvent(new Date());
  const pool = getPool();

  let brokenPayload = null;
  let boostPayload = null;
  try { brokenPayload = broken ? JSON.parse(broken.payload_json) : null; } catch {}
  try { boostPayload = boost ? JSON.parse(boost.payload_json) : null; } catch {}

  // mastery summaries
  let masteryByCase = {};
  if (me) {
    const rows = db.prepare('SELECT case_id, xp, level FROM mastery WHERE user_id=?').all(me.id);
    masteryByCase = Object.fromEntries(rows.map(r => [r.case_id, { xp: r.xp, level: r.level }]));
  }

  return {
    props: {
      me,
      cases: cases.map(c => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        image_url: c.image_url,
        case_price_gems: (c.case_price_cents / 100).toFixed(2),
        key_price_gems: (c.key_price_cents / 100).toFixed(2),
        is_broken: brokenPayload?.case_id === c.id,
        mastery: masteryByCase[c.id] || null,
      })),
      events: {
        brokenPayload,
        brokenWindow: broken ? { start_at: broken.start_at, end_at: broken.end_at } : null,
        boostPayload,
        boostWindow: boost ? { start_at: boost.start_at, end_at: boost.end_at } : null,
      },
      pool: {
        tier: pool.tier,
        tier_name: pool.tier_name,
        progress_gems: (pool.progress_cents / 100).toFixed(2),
        currentThreshold_gems: (pool.currentThreshold_cents / 100).toFixed(2),
        nextThreshold_gems: (pool.nextThreshold_cents / 100).toFixed(2),
      }
    }
  };
}

function ProgressBar({ value, max }) {
  const v = Number(value);
  const m = Math.max(1, Number(max));
  const pct = Math.max(0, Math.min(100, (v / m) * 100));
  return (
    <div className="w-full rounded-full bg-zinc-800 h-3 overflow-hidden">
      <div className="h-3 bg-emerald-600" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function Home({ me, cases, events, pool }) {
  const broken = events?.brokenPayload;
  const boost = events?.boostPayload;

  return (
    <Layout me={me} title="Cases">
      <div className="grid gap-4 mb-6">
        {/* Events */}
        {(broken || boost) ? (
          <div className="card">
            <div className="flex flex-col gap-2">
              {boost ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">🎉 Bros Boost Day</div>
                    <div className="small">
                      +{Math.round((Number(boost.gem_earn_mult || 1) - 1) * 100)}% gem earnings, +{Math.round((Number(boost.streak_mult || 1) - 1) * 100)}% streak rewards
                      {boost.discount ? `, ${Math.round(Number(boost.discount) * 100)}% off cases/keys` : ''}
                    </div>
                  </div>
                  {events.boostWindow ? (
                    <div className="badge">Ends {dayjs(events.boostWindow.end_at).format('YYYY-MM-DD HH:mm')} UTC</div>
                  ) : null}
                </div>
              ) : null}

              {broken ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">⚡ Broken Case Hour</div>
                    <div className="small">
                      <span className="text-zinc-100">{broken.case_name}</span> is broken for 1 hour — rare weights ×{broken.rare_weight_mult}
                      {broken.discount ? `, ${Math.round(Number(broken.discount) * 100)}% off` : ''}
                    </div>
                  </div>
                  {events.brokenWindow ? (
                    <div className="badge">Ends {dayjs(events.brokenWindow.end_at).format('YYYY-MM-DD HH:mm')} UTC</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="font-semibold">No events live right now</div>
            <div className="small">Broken Case Hour can start any hour, and Bros Boost Days trigger randomly.</div>
          </div>
        )}

        {/* Pool */}
        <div className="card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold">🏦 Progressive Giveaway Pool</div>
              <div className="small">
                Tier: <span className="text-zinc-100 font-semibold">{pool.tier_name}</span> •
                Progress: <span className="text-zinc-100 font-semibold">{pool.progress_gems}</span> gems spent by the community
              </div>
            </div>
            <Link className="btn" href="/giveaways">View giveaways</Link>
          </div>

          <div className="mt-3 grid gap-2">
            <ProgressBar value={pool.progress_gems} max={pool.nextThreshold_gems} />
            <div className="text-xs text-zinc-400">
              Next tier at <span className="text-zinc-200 font-semibold">{pool.nextThreshold_gems}</span> gems spent
            </div>
          </div>
        </div>

        {/* Streak */}
        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">🔥 Daily Streak</div>
              <div className="small">Claim daily gems. Day 15 pays up to 100 gems (before boost).</div>
            </div>
            {me ? (
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const r = await fetch('/api/streak/claim', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({})});
                  const j = await r.json();
                  if (j.error) alert(j.error);
                  else window.location.reload();
                }}
              >
                Claim today
              </button>
            ) : (
              <a href="/auth/steam" className="btn btn-primary">Sign in to claim</a>
            )}
          </div>
        </div>

        {/* Ad slot */}
        <div className="card">
          <div className="text-sm font-semibold">Ad slot</div>
          <div className="small">Replace this with your ad provider embed/script (Google AdSense, etc.).</div>
        </div>
      </div>

      {/* Cases grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cases.map(c => (
          <Link key={c.slug} href={`/cases/${c.slug}`} className="card hover:border-zinc-600 transition">
            <div className="flex flex-col gap-3">
              <div className="aspect-[3/2] rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900">
                {c.image_url ? (
                  <img alt={c.name} src={c.image_url} className="w-full h-full object-cover" />
                ) : null}
              </div>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{c.name}</div>
                  <div className="small">Case {c.case_price_gems} • Key {c.key_price_gems}</div>
                </div>
                {c.is_broken ? <span className="badge border-emerald-600 text-emerald-200">Broken</span> : null}
              </div>

              {c.mastery ? (
                <div className="text-xs text-zinc-400">
                  Mastery: <span className="text-zinc-200 font-semibold">Lv {c.mastery.level}</span> • XP {c.mastery.xp}
                </div>
              ) : (
                <div className="text-xs text-zinc-500">Open to build mastery</div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </Layout>
  );
}
