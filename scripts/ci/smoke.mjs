#!/usr/bin/env node
// Post-deploy smoke test of the surface that was actually deployed.
//
// WHAT WAS WRONG. Both deploys verified liveness and called it done. The
// engine's external check was `curl -fs https://brain.inite.ai/health`,
// and warning-only besides. `/health` returns 200 as soon as Nest binds a
// port — it says nothing about whether the API is mounted, whether auth
// is enforced, or whether Traefik is routing to the new container rather
// than to a stale one.
//
// Worse, the landing's check asserted `/health` too, and on the shared
// brain.inite.ai host `/health` is claimed by the BACKEND router
// (PathPrefix, priority 200) — so the landing's deploy was gating on the
// engine's health. One service's release could fail because a different
// service was down, and a landing deploy could report green while landing
// itself served nothing but the paths it was asked about.
//
// So each surface asserts the routes IT owns, and the assertions are
// about behaviour a dead or misrouted deploy cannot fake: an unauthenticated
// POST to /v1/search must come back 401, not 404. 404 means the route is
// not mounted; 200 means auth is not enforced. Only 401 means the surface
// is there and fail-closed.

const SURFACES = {
  brain: [
    { path: '/health', method: 'GET', expect: [200], why: 'engine is live behind Traefik' },
    {
      path: '/ready',
      method: 'GET',
      expect: [200],
      // This is also the load balancer's own contract: Traefik health-checks
      // /ready and takes an unready replica out of rotation, so if the
      // router rule for it is missing the check 404s, every replica is
      // marked down, and the domain serves nothing. A 404 here IS that bug.
      why: 'readiness is routed through the domain — the load balancer probes it',
    },
    {
      path: '/v1/search',
      method: 'POST',
      expect: [401],
      why: 'API surface is mounted AND fail-closed (404 = not mounted, 200 = auth bypassed)',
    },
    {
      path: '/mcp/smoke-probe',
      method: 'GET',
      // The Streamable-HTTP transport answers a bare GET in several
      // legitimate ways depending on headers; what matters is that the
      // route exists and refuses. 404 or 5xx is a broken deploy.
      expect: [400, 401, 405, 406],
      why: 'MCP transport is mounted and refuses an unauthenticated probe',
    },
    {
      // The 401 above names this document in WWW-Authenticate, so an MCP
      // client following RFC 9728 lands here. brain.inite.ai also fronts
      // the marketing site, and a Traefik rule that forgets this prefix
      // sends the client to a 200-or-404 HTML page instead — discovery
      // dead-ends with no error anyone sees. Assert the JSON body, not
      // just the status: the landing app can answer 200 too.
      path: '/.well-known/oauth-protected-resource',
      method: 'GET',
      expect: [200],
      jsonHas: 'authorization_servers',
      why: 'RFC 9728 discovery reaches the API (not the landing app)',
    },
  ],
  landing: [
    { path: '/en', method: 'GET', expect: [200], why: 'the localized site renders' },
    { path: '/skills.tar.gz', method: 'GET', expect: [200], why: 'the skills bundle is published' },
    { path: '/install.sh', method: 'GET', expect: [200], why: 'the installer is published' },
    { path: '/openapi.json', method: 'GET', expect: [200], why: 'the published spec is served' },
    // NOTE: /health is deliberately absent. Traefik routes it to the
    // engine, so asserting it here made the landing's deploy fail
    // whenever the engine was unhealthy — a cross-service gate nobody
    // asked for.
  ],
};

const BASE = (process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
const SURFACE = process.env.SMOKE_SURFACE ?? '';
const REACH_ATTEMPTS = Number(process.env.SMOKE_REACH_ATTEMPTS ?? '12');
const REACH_DELAY_SECONDS = Number(process.env.SMOKE_REACH_DELAY_SECONDS ?? '10');

function fail(message) {
  console.error(`[smoke] ${message}`);
  process.exit(1);
}

if (!BASE) fail('SMOKE_BASE_URL is not set');
const checks = SURFACES[SURFACE];
if (!checks) fail(`unknown SMOKE_SURFACE "${SURFACE}" (expected one of: ${Object.keys(SURFACES)})`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the status, plus — when the check asks for a JSON key — whether
 * the body actually parsed and carried it. A shared host means the wrong
 * backend can answer with the right status code, so some routes are only
 * verified by what comes back in the body.
 */
async function probe(check) {
  const res = await fetch(`${BASE}${check.path}`, {
    method: check.method,
    redirect: 'manual',
    headers: { accept: 'application/json' },
    // A hung upstream must not hang the deploy.
    signal: AbortSignal.timeout(15_000),
  });
  if (!check.jsonHas) return { status: res.status };
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: res.status, jsonOk: false, detail: 'body is not JSON' };
  }
  const jsonOk = body !== null && typeof body === 'object' && check.jsonHas in body;
  return { status: res.status, jsonOk, detail: jsonOk ? undefined : `missing "${check.jsonHas}"` };
}

async function status(check) {
  return (await probe(check)).status;
}

/**
 * Wait for the host to answer at all before judging individual routes.
 * On a first deploy, DNS and the Let's Encrypt cert can take a minute,
 * and that is not the same failure as a broken route.
 */
async function waitForReachable() {
  const probe = checks[0];
  for (let attempt = 1; attempt <= REACH_ATTEMPTS; attempt += 1) {
    try {
      await status(probe);
      return true;
    } catch (err) {
      console.log(`[smoke] ${BASE} not reachable yet (${attempt}/${REACH_ATTEMPTS}): ${err.message}`);
      await sleep(REACH_DELAY_SECONDS * 1000);
    }
  }
  return false;
}

async function main() {
  if (!(await waitForReachable())) {
    fail(
      `${BASE} never answered. If this is a first deploy, check the DNS A record and the ` +
        'Traefik certificate; otherwise the container is not being routed to.',
    );
  }

  let failed = 0;
  for (const check of checks) {
    let got;
    try {
      got = await probe(check);
    } catch (err) {
      console.error(`[smoke] ERR ${check.method} ${check.path} — request failed: ${err.message}`);
      failed += 1;
      continue;
    }
    const ok = check.expect.includes(got.status) && (check.jsonHas ? got.jsonOk === true : true);
    if (!ok) failed += 1;
    console.log(
      `[smoke] ${ok ? 'ok ' : 'ERR'} ${check.method} ${check.path} -> ${got.status} ` +
        `(want ${check.expect.join('|')}${check.jsonHas ? ` + JSON.${check.jsonHas}` : ''}` +
        `${got.detail ? `; ${got.detail}` : ''}) — ${check.why}`,
    );
  }

  if (failed > 0) fail(`${failed} of ${checks.length} checks failed on ${BASE}`);
  console.log(`[smoke] all ${checks.length} checks passed on ${BASE}`);
}

main().catch((err) => fail(err.stack ?? String(err)));
