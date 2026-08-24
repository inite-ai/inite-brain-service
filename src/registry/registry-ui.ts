import type { RegistryPackSummary } from '../contracts/registry/registry.schema';
import type { PublisherProfile } from '../contracts/registry/marketplace.schema';
import { formatPrice, isHttpUrl, splitFeatured } from './marketplace-meta';

/**
 * Server-rendered HTML for the pack registry catalogue browser (a public,
 * read-only discovery page over the global registry — like a package index)
 * and the per-publisher marketplace page. Pure + dependency-free so it's
 * unit-testable; the controller supplies the summaries. All dynamic values
 * are HTML-escaped; profile URLs render as links ONLY when they parse as
 * http(s) — a stored `javascript:` URL renders as inert text.
 */

function esc(s: unknown): string {
  // Coerce first: a non-string value (e.g. a numeric description that slipped
  // past the DB projection) would otherwise throw `.replace is not a function`
  // and 500 the public page.
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Host part of a mirrored pack's origin URL — falls back to the raw value
 *  when it isn't parseable (it still goes through esc()). */
function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function card(p: RegistryPackSummary): string {
  const tags = p.keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join('');
  // Green "verified" = signature validated against THIS instance's trust
  // store at publish time; neutral "signed" = carries a signature nobody here
  // vouches for. Deliberately distinct — a bare signature proves nothing to a
  // visitor. Verified implies signed, so only the stronger badge is shown.
  const badge = p.verified
    ? '<span class="badge verified">verified</span>'
    : p.signed
      ? '<span class="badge signed">signed</span>'
      : '';
  const featured = p.featured ? '<span class="badge featured">featured</span>' : '';
  // Paid marketplace pack (registry_pack_meta) — the displayPrice is
  // denormalized discovery metadata; checkout resolves the real price.
  const price = p.paid
    ? `<span class="badge price">${p.displayPrice ? esc(formatPrice(p.displayPrice)) : 'paid'}</span>`
    : '';
  // encodeURIComponent leaves no character esc() would rewrite except `'`,
  // and the attribute is double-quoted — but esc() anyway (belt+braces).
  const publisher = p.publisher
    ? `<span class="pub">by <a href="/registry/ui/publisher/${esc(encodeURIComponent(String(p.publisher)))}">${esc(p.publisher)}</a></span>`
    : '';
  const published = p.publishedAt
    ? `<span class="date">published ${esc(String(p.publishedAt).slice(0, 10))}</span>`
    : '';
  // Pull-only mirror provenance (migration 0064): the latest installable
  // version was pulled from another instance's registry.
  const mirrored = p.origin
    ? `<span class="origin">mirrored from ${esc(originHost(String(p.origin)))}</span>`
    : '';
  return `<article class="pack">
  <h2>${esc(p.packId)} <span class="ver">v${esc(p.latestVersion)}</span> ${badge}${featured}${price}</h2>
  <p class="desc">${esc(p.description || '(no description)')}</p>
  <div class="meta">${tags}${publisher}${mirrored}<span class="dl">${esc(p.downloads ?? 0)} download(s)</span>${published}<span class="vc">${p.versionCount} version(s)</span></div>
  <code class="install">pnpm pack:install -- --registry ${esc(p.packId)}</code>
</article>`;
}

const PAGE_STYLE = `
:root{color-scheme:light dark}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.6rem;margin:0 0 .25rem}
.sub{color:#888;margin:0 0 1.5rem}
.sec{font-size:1.05rem;margin:0 0 .75rem;color:#888;text-transform:uppercase;letter-spacing:.05em}
.featured-sec{margin:0 0 1.5rem}
.pack{border:1px solid #8883;border-radius:10px;padding:1rem 1.25rem;margin:0 0 1rem}
.pack h2{font-size:1.15rem;margin:0 0 .25rem}
.ver{color:#888;font-weight:400;font-size:.9rem}
.badge{font-size:.7rem;padding:.1rem .4rem;border-radius:4px;vertical-align:middle;margin-right:.2rem}
.badge.signed{background:#8883}
.badge.verified{background:#2e7d32;color:#fff}
.badge.featured{background:#f9a825;color:#000}
.badge.price{background:#1565c0;color:#fff}
.desc{margin:.25rem 0 .5rem}
.meta{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;font-size:.8rem;color:#888;margin-bottom:.5rem}
.tag{background:#8882;border-radius:4px;padding:.1rem .45rem}
.pub a{color:inherit}
.origin{font-style:italic}
.install{display:block;background:#8881;padding:.5rem .6rem;border-radius:6px;font-size:.8rem;overflow-x:auto}
.bio{margin:.25rem 0 1rem;white-space:pre-line}
.back{font-size:.85rem}
#q{width:100%;padding:.6rem .75rem;border:1px solid #8884;border-radius:8px;margin-bottom:1.25rem;font-size:1rem;box-sizing:border-box}
.empty{color:#888}
`;

function page(args: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(args.title)}</title>
<style>${PAGE_STYLE}</style></head><body>
${args.body}
</body></html>`;
}

export function renderRegistryPage(packs: RegistryPackSummary[]): string {
  const { featured, rest } = splitFeatured(packs);
  const featuredSection =
    featured.length === 0
      ? ''
      : `<section class="featured-sec"><h2 class="sec">Featured</h2>
${featured.map(card).join('\n')}</section>\n`;
  const body =
    packs.length === 0
      ? '<p class="empty">No packs published yet. Publish one with <code>pnpm pack:publish</code>.</p>'
      : featuredSection + rest.map(card).join('\n');
  return page({
    title: 'Brain — Domain Pack registry',
    body: `<h1>Domain Pack registry</h1>
<p class="sub">${packs.length} pack(s) · install with <code>pnpm pack:install -- --registry &lt;id&gt;</code></p>
<input id="q" placeholder="Filter packs…" oninput="for(const a of document.querySelectorAll('.pack')){a.style.display=a.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'}">
<main>${body}</main>`,
  });
}

/** A publisher's public page: profile (when one was written) + their packs.
 *  An unknown publisher gets an empty-state page — never a 500. */
export function renderPublisherPage(args: {
  publisher: string;
  profile: PublisherProfile | null;
  packs: RegistryPackSummary[];
}): string {
  const { publisher, profile, packs } = args;
  const name = profile?.displayName || publisher;
  // Link ONLY a URL that parses as http(s) — a stored `javascript:` (or
  // otherwise unparseable) value renders as inert escaped text.
  const url = profile?.url
    ? isHttpUrl(String(profile.url))
      ? `<span><a href="${esc(profile.url)}" rel="nofollow noopener">${esc(profile.url)}</a></span>`
      : `<span>${esc(profile.url)}</span>`
    : '';
  const email = profile?.contactEmail ? `<span>${esc(profile.contactEmail)}</span>` : '';
  const bio = profile?.bio ? `<p class="bio">${esc(profile.bio)}</p>` : '';
  const packsBody =
    packs.length === 0
      ? '<p class="empty">No packs from this publisher in this registry.</p>'
      : packs.map(card).join('\n');
  return page({
    title: `Brain — packs by ${name}`,
    body: `<p class="back"><a href="/registry/ui">← Domain Pack registry</a></p>
<h1>${esc(name)}</h1>
<p class="sub">publisher <code>${esc(publisher)}</code></p>
${bio}<div class="meta">${url}${email}</div>
<main>${packsBody}</main>`,
  });
}
