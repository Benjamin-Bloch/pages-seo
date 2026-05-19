// Lists which AI providers are configured (have a key/binding) so the
// admin UI can populate a "preferred provider" dropdown.
import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { listProviders } from '../../_lib/ai.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  return json(200, await listProviders(env));
};
