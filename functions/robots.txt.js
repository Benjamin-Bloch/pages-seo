// Serves robots.txt. Overrides Cloudflare's managed file if AI-bot
// blocking is enabled at the project level.
export const onRequestGet = ({ env, request }) => {
  const host = new URL(request.url).hostname;
  const body = `# pages-seo robots policy
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin

# AI training crawlers — block by default.
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: CCBot
Disallow: /

Sitemap: https://${host}/sitemap.xml
`;
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
