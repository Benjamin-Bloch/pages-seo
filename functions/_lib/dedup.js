// AI similarity de-dup for blog posts.
//
// We embed the candidate topic (title + angle) with Cloudflare Workers
// AI's BGE base model, fetch the embeddings of recent published posts,
// and compare cosine similarity. Anything above SIMILARITY_THRESHOLD is
// considered a duplicate.
//
// The model is tiny (~6k neurons / M tokens) so this adds negligible
// cost to a generation. We cache embeddings on each blog_posts row so
// we only embed each post once.

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
// 0.80 in practice — BGE embeddings cluster same-niche content tightly,
// so all "SEO" posts share heavy vocabulary overlap. Empirically:
//   - near-verbatim rewrite of an existing post: ~0.83
//   - same topic family, different angle:       ~0.77
//   - clearly distinct topic, same niche:       ~0.73
// 0.80 catches the rewrites while letting through family-related but
// distinct angles. Bump higher if too many family-relateds get blocked.
const SIMILARITY_THRESHOLD = 0.80;
const RECENT_POSTS_TO_CHECK = 50;      // 50 most recent published posts
const MAX_TEXT_FOR_EMBED = 1500;       // chars; well within model's 512 tokens

// Embed a string. Returns { vector, dims, model } or throws.
export async function embed(env, text) {
  const trimmed = String(text || '').slice(0, MAX_TEXT_FOR_EMBED);
  if (!trimmed) throw new Error('embed: empty text');
  const out = await env.AI.run(EMBED_MODEL, { text: [trimmed] });
  // The model returns { shape: [1, 768], data: [[...]] } or sometimes
  // { data: [...] }. Normalise.
  const vec = Array.isArray(out?.data?.[0]) ? out.data[0]
            : Array.isArray(out?.data)       ? out.data
            : null;
  if (!vec || !vec.length) throw new Error('embed: bad model response');
  return { vector: vec, dims: vec.length, model: EMBED_MODEL };
}

// Standard cosine similarity. Both vectors must be the same length.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Given a candidate topic (key + angle), check whether anything in the
// recent published-posts pool is too similar. Returns:
//   { duplicate: bool, similarity, against: { slug, title, score } | null,
//     scored: [{slug,title,score}] }
//
// `scored` lists the top 5 most-similar existing posts for debugging.
export async function checkDuplicate(env, { title, angle }) {
  if (!env?.AI || !env?.DB) {
    // Best-effort: if AI binding missing, never block.
    return { duplicate: false, similarity: 0, against: null, scored: [], skipped: 'no_ai_binding' };
  }
  const candidate = String(title || '') + ' — ' + String(angle || '');
  let candidateVec;
  try { candidateVec = (await embed(env, candidate)).vector; }
  catch (e) { return { duplicate: false, similarity: 0, against: null, scored: [], error: String(e?.message || e) }; }

  const rows = await env.DB.prepare(
    `SELECT slug, title, meta_description, embedding
       FROM blog_posts
      WHERE status = 'published' AND embedding IS NOT NULL
      ORDER BY published_at DESC LIMIT ?`
  ).bind(RECENT_POSTS_TO_CHECK).all().catch(() => ({ results: [] }));

  const scored = [];
  for (const r of (rows.results || [])) {
    let v;
    try { v = JSON.parse(r.embedding); } catch { continue; }
    if (!Array.isArray(v) || v.length !== candidateVec.length) continue;
    const score = cosine(candidateVec, v);
    scored.push({ slug: r.slug, title: r.title, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] || null;
  return {
    duplicate: !!top && top.score >= SIMILARITY_THRESHOLD,
    similarity: top?.score || 0,
    against: top,
    scored: scored.slice(0, 5),
    threshold: SIMILARITY_THRESHOLD,
  };
}

// Pick a non-duplicate topic. Calls `pickFn()` up to `maxTries` times,
// each call returning a fresh candidate. Returns:
//   { topic, dup, tries, fallback }
//   - topic: the chosen topic (the cleanest available)
//   - dup: similarity check result for the chosen topic
//   - tries: how many candidates we burned through
//   - fallback: true if all candidates were duplicates and we picked the
//               least-similar one anyway (logged so cron keeps publishing)
export async function pickNonDuplicate(env, pickFn, { maxTries = 5 } = {}) {
  const burned = [];
  for (let i = 0; i < maxTries; i++) {
    const topic = await pickFn();
    if (!topic) break;
    const dup = await checkDuplicate(env, { title: topic.angle, angle: topic.angle });
    if (!dup.duplicate) {
      return { topic, dup, tries: i + 1, fallback: false };
    }
    burned.push({ topic, dup });
  }
  // Everything was a duplicate. Pick the candidate that was LEAST
  // similar so we still publish. The cron stays alive; admin can audit
  // the warning in the post metadata.
  if (!burned.length) {
    // pickFn returned nothing (empty pool) — give up
    return { topic: null, dup: null, tries: maxTries, fallback: true };
  }
  burned.sort((a, b) => a.dup.similarity - b.dup.similarity);
  const best = burned[0];
  return { topic: best.topic, dup: best.dup, tries: burned.length, fallback: true };
}

// Embed + persist a post's embedding. Called from publish.js so every
// new post immediately participates in future dedup checks.
export async function storeEmbedding(env, slug, { title, body_markdown, meta_description }) {
  if (!env?.AI || !env?.DB) return { ok: false, reason: 'no_binding' };
  // We embed title + meta + first ~1k of body. Captures the topic well
  // without exceeding the model's input limit.
  const body = String(body_markdown || '').slice(0, 800);
  const text = `${title || ''}\n${meta_description || ''}\n${body}`;
  try {
    const { vector, model } = await embed(env, text);
    await env.DB.prepare(
      `UPDATE blog_posts SET embedding = ?, embedding_model = ?, embedding_at = ?
         WHERE slug = ?`
    ).bind(JSON.stringify(vector), model, Math.floor(Date.now() / 1000), slug).run();
    return { ok: true, dims: vector.length };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}
