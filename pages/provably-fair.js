import Layout from '../components/Layout';
import { getMe } from '../lib/getMe';
import { useState } from 'react';

export async function getServerSideProps(ctx) {
  const me = getMe(ctx);
  const openId = ctx.query.openId || '';
  let verification = null;
  if (openId) {
    const { verifyOpen } = require('../lib/verify');
    verification = verifyOpen(openId);
  }
  return { props: { me, openId, verification } };
}

export default function ProvablyFair({ me, openId, verification }) {
  const [id, setId] = useState(openId || '');

  return (
    <Layout me={me} title="Provably Fair">
      <div className="card mb-4">
        <div className="font-semibold">How it works</div>
        <div className="small mt-2 space-y-2">
          <div>
            case-bros uses a commit–reveal approach:
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Before opening, you see a <span className="font-mono text-zinc-200">serverSeedHash</span> (the commitment).</li>
              <li>You supply a <span className="font-mono text-zinc-200">clientSeed</span>.</li>
              <li>The server uses HMAC-SHA256(serverSeed, clientSeed:nonce:caseId:modifiersHash) to generate a roll.</li>
              <li>After the open, the server reveals <span className="font-mono text-zinc-200">serverSeed</span> so anyone can recompute and verify.</li>
              <li>The server then rotates to a new seed for the next open.</li>
            </ul>
          </div>
          <div className="text-zinc-500 text-xs">
            Note: If odds change via events (Broken Case Hour / Bros Boost), those modifiers are included in the modifiersHash so the proof still matches.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="font-semibold">Verify an open</div>
        <div className="small mt-1">Paste an Open ID (shown after opening a case).</div>

        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <input className="input flex-1" value={id} onChange={e => setId(e.target.value)} placeholder="Open ID (e.g., 123)" />
          <button className="btn btn-primary" onClick={() => { window.location.href = `/provably-fair?openId=${encodeURIComponent(id)}`; }}>
            Verify
          </button>
        </div>

        {verification ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            {verification.ok ? (
              <>
                <div className="text-sm font-semibold">Verification result</div>
                <div className="text-xs text-zinc-400 mt-2">
                  Matches stored outcome: <span className={`font-semibold ${verification.matches ? 'text-emerald-300' : 'text-red-300'}`}>{String(verification.matches)}</span>
                </div>
                <div className="mt-3 text-xs text-zinc-400 grid gap-1">
                  <div>Open ID: <span className="font-mono text-zinc-200">{verification.open_id}</span></div>
                  <div>Case: <span className="text-zinc-200">{verification.case?.name}</span></div>
                  <div>Computed roll: <span className="font-mono text-zinc-200">{verification.computed_roll}</span> • Stored roll: <span className="font-mono text-zinc-200">{verification.stored_roll}</span></div>
                  <div>Expected item: <span className="text-zinc-200">{verification.expected_item?.name}</span> (id {verification.expected_item?.item_id})</div>
                  <div>Stored item id: <span className="font-mono text-zinc-200">{verification.stored_item_id}</span></div>
                  <div>HMAC: <span className="font-mono text-zinc-200 break-all">{verification.computed_hmac}</span></div>
                </div>
              </>
            ) : (
              <div className="text-sm text-red-300">Error: {verification.error}</div>
            )}
          </div>
        ) : null}
      </div>
    </Layout>
  );
}
