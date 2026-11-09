// Cloudflare Worker: serves the website's files and answers the hockey-pool requests at /api.
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // www.puck-off.com -> puck-off.com (same page)
    if (url.hostname === 'www.puck-off.com') {
      url.hostname = 'puck-off.com';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return onRequest({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
