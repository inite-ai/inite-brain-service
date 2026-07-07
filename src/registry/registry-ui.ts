import type { RegistryPackSummary } from '../contracts/registry/registry.schema';

/**
 * Server-rendered HTML for the pack registry catalogue browser (a public,
 * read-only discovery page over the global registry — like a package index).
 * Pure + dependency-free so it's unit-testable; the controller supplies the
 * summaries. All dynamic values are HTML-escaped.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function card(p: RegistryPackSummary): string {
  const tags = p.keywords
    .map((k) => `<span class="tag">${esc(k)}</span>`)
    .join('');
  const badge = p.signed ? '<span class="badge">signed</span>' : '';
  const publisher = p.publisher
    ? `<span class="pub">by ${esc(p.publisher)}</span>`
    : '';
  return `<article class="pack">
  <h2>${esc(p.packId)} <span class="ver">v${esc(p.latestVersion)}</span> ${badge}</h2>
  <p class="desc">${esc(p.description || '(no description)')}</p>
  <div class="meta">${tags}${publisher}<span class="vc">${p.versionCount} version(s)</span></div>
  <code class="install">pnpm pack:install -- --registry ${esc(p.packId)}</code>
</article>`;
}

export function renderRegistryPage(packs: RegistryPackSummary[]): string {
  const body =
    packs.length === 0
      ? '<p class="empty">No packs published yet. Publish one with <code>pnpm pack:publish</code>.</p>'
      : packs.map(card).join('\n');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brain — Domain Pack registry</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.6rem;margin:0 0 .25rem}
.sub{color:#888;margin:0 0 1.5rem}
.pack{border:1px solid #8883;border-radius:10px;padding:1rem 1.25rem;margin:0 0 1rem}
.pack h2{font-size:1.15rem;margin:0 0 .25rem}
.ver{color:#888;font-weight:400;font-size:.9rem}
.badge{background:#2e7d32;color:#fff;font-size:.7rem;padding:.1rem .4rem;border-radius:4px;vertical-align:middle}
.desc{margin:.25rem 0 .5rem}
.meta{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;font-size:.8rem;color:#888;margin-bottom:.5rem}
.tag{background:#8882;border-radius:4px;padding:.1rem .45rem}
.install{display:block;background:#8881;padding:.5rem .6rem;border-radius:6px;font-size:.8rem;overflow-x:auto}
#q{width:100%;padding:.6rem .75rem;border:1px solid #8884;border-radius:8px;margin-bottom:1.25rem;font-size:1rem;box-sizing:border-box}
.empty{color:#888}
</style></head><body>
<h1>Domain Pack registry</h1>
<p class="sub">${packs.length} pack(s) · install with <code>pnpm pack:install -- --registry &lt;id&gt;</code></p>
<input id="q" placeholder="Filter packs…" oninput="for(const a of document.querySelectorAll('.pack')){a.style.display=a.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'}">
<main>${body}</main>
</body></html>`;
}
