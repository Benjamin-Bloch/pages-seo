// GET /api/update/github/status
//
// Tells the /update SPA whether the operator's OAuth session is live.
// Returns { connected: bool, login?: string }.

import { json } from '../../../_lib/util.js';
import { readOAuthCookie } from '../../../_lib/oauth_cookie.js';

export const onRequestGet = async ({ env, request }) => {
  const c = await readOAuthCookie(env, request);
  if (c?.token) return json(200, { connected: true, login: c.login || null });
  return json(200, { connected: false });
};
