// Cloudflare Worker: serves the website's files, the search-engine pages and the hockey-pool requests at /api.
import { onRequest } from './api.js';
import { renderPredictions, sitemap, SITE } from './seo.js';
import { takeSnapshot } from './snap.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    // One official address: www.puck-off.com and the old workers.dev address move to puck-off.com (same page)
    if (url.hostname === 'www.puck-off.com' || (url.hostname.endsWith('.workers.dev') && isRead && !isApi)) {
      return Response.redirect(SITE + url.pathname + url.search, 301);
    }
    if (isApi) return onRequest({ request, env, ctx });
    if (url.pathname === '/index.html') return Response.redirect(url.origin + '/' + url.search, 301);
    if (url.pathname === '/sitemap.xml') {
      return new Response(sitemap(), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    if (url.pathname === '/nhl-predictions' || url.pathname === '/nhl-predictions/') {
      if (url.pathname.endsWith('/')) return Response.redirect(url.origin + '/nhl-predictions', 301);
      const html = await renderPredictions(env, url.origin);
      return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' } });
    }
    return env.ASSETS.fetch(request);
  },
  // hourly: stat snapshot for monthly pools
  async scheduled(event, env, ctx) {
    ctx.waitUntil(takeSnapshot(env).then(r => console.log('snapshot', JSON.stringify(r))).catch(e => console.log('snapshot failed', String(e))));
  },
};
