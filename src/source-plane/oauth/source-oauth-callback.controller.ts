import { Controller, Get, Header, NotFoundException, Query } from '@nestjs/common';
import { sourceOAuthClientEnabled, sourcePlaneEnabled } from '../../common/source-plane-flags';
import { OAuthCallbackError } from './oauth-errors';
import { SourceOAuthService } from './source-oauth.service';

/**
 * The provider's return leg — PUBLIC by construction (the browser
 * arrives from Google / Microsoft / Dropbox with no brain credential;
 * the signed `state` is what authenticates the request). The response
 * is a small HTML page that hands the result to the admin window that
 * opened it (`postMessage` to the origin the start request named, and
 * to that origin only) and closes; without an opener it just says so.
 *
 * No token, code or state ever appears in the page: the outcome is a
 * grant id and an account label, or an error sentence.
 */
@Controller('v1/source-connections/oauth')
export class SourceOAuthCallbackController {
  constructor(private readonly oauth: SourceOAuthService) {}

  @Get('callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async callback(@Query() query: Record<string, string | string[] | undefined>): Promise<string> {
    if (!sourcePlaneEnabled() || !sourceOAuthClientEnabled()) throw new NotFoundException();
    const one = (k: string): string | undefined => {
      const v = query[k];
      return typeof v === 'string' ? v : undefined;
    };
    try {
      const r = await this.oauth.callback({
        state: one('state'),
        code: one('code'),
        error: one('error'),
        errorDescription: one('error_description'),
      });
      return callbackPage({
        ok: true,
        grantId: r.grantId,
        provider: r.provider,
        account: r.account,
        origin: r.origin,
      });
    } catch (e) {
      if (e instanceof OAuthCallbackError) {
        return callbackPage({ ok: false, error: e.message, origin: e.origin });
      }
      throw e;
    }
  }
}

type Outcome =
  | { ok: true; grantId: string; provider: string; account: string | null; origin: string | null }
  | { ok: false; error: string; origin: string | null };

/** Exposed for tests. */
export function callbackPage(o: Outcome): string {
  const payload = JSON.stringify({ type: 'brain-source-oauth', ...o });
  const origin = JSON.stringify(o.origin ?? '');
  const text = o.ok
    ? `Connected${o.account ? ` ${escapeHtml(o.account)}` : ''} (${escapeHtml(o.provider)}). You can close this window.`
    : `Could not connect: ${escapeHtml(o.error)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>brain — connected account</title>
<meta name="robots" content="noindex">
<style>body{font:14px system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#222}p{line-height:1.5}</style>
</head><body>
<p id="msg">${text}</p>
<script>
(function(){
  var payload = ${escapeScript(payload)};
  var origin = ${escapeScript(origin)};
  try {
    if (window.opener && origin) { window.opener.postMessage(payload, origin); setTimeout(function(){ window.close(); }, 400); }
  } catch (e) {}
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** JSON inside a <script>: `</` must never close the tag. */
function escapeScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
