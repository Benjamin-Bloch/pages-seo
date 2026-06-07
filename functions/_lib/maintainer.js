// Is this deployment the upstream maintainer's, or a user's install?
//
// On the upstream demo (seo.benjaminb.xyz) we want /install, /update,
// /install/run.*, and the marketing index page to all work — it's
// what makes the project discoverable. On a user's install of the
// same code, none of that makes sense; their site is a content
// product, not a clone of the demo.
//
// The flag lives in two places, in priority order:
//   1. env.IS_MAINTAINER === '1'  (Pages secret; survives a fresh
//      clone if the maintainer sets it manually)
//   2. settings.is_maintainer === '1'  (D1 row; written on the
//      upstream by the maintainer at deploy time)
//
// Both default to falsy. A user's install never sees either set.

import { loadSettings } from './settings.js';

export async function isMaintainer(env) {
  if (env?.IS_MAINTAINER === '1' || env?.IS_MAINTAINER === 'true') return true;
  if (!env?.DB) return false;
  try {
    const s = await loadSettings(env);
    return s?.is_maintainer === '1' || s?.is_maintainer === 'true';
  } catch {
    return false;
  }
}
