// Kinship Combat: one small Cloudflare Worker.
// /api/*  -> the encounter server (rolls, rooms, rate limits), stored in D1
// anything else -> the static files in /public (the table page)
import { handle } from './api.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handle(request, env.DB, env.CREATE_PASSWORD, env.MEMBER_PASSWORD, env.BANK_PASSWORD, { sectPasswords: env.SECT_PASSWORDS, sectContentUrl: env.SECT_CONTENT_URL, siteOrigins: env.SITE_ORIGINS, scenePassword: env.SCENE_PASSWORD });
    }
    if (url.pathname === '/' || url.pathname === '/table' || url.pathname === '/table/') {
      return Response.redirect(url.origin + '/table/index.html' + url.search, 302);
    }
    return env.ASSETS.fetch(request);
  },
};
