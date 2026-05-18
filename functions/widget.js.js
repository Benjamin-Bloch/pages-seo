// /widget.js — a tiny JS snippet other sites can drop in to show recent
// posts from this pages-seo instance.
//
// Usage on the parent site:
//   <div id="my-blog-widget"></div>
//   <script src="https://<your-host>/widget.js"
//     data-target="#my-blog-widget"
//     data-count="5"
//     data-title="Latest from our blog"
//     defer></script>
//
// The widget reads its own <script> tag's data-* attributes, fetches
// /api/widget?count=N from the same origin it was served from, and renders
// minimal HTML via safe DOM methods (textContent / createElement).
export const onRequestGet = ({ request }) => {
  const origin = new URL(request.url).origin;
  const js = `(function(){
  var script = document.currentScript;
  if (!script) return;
  var target = document.querySelector(script.getAttribute('data-target') || '#pages-seo-widget');
  if (!target) return;
  var count = Math.max(1, Math.min(20, parseInt(script.getAttribute('data-count'), 10) || 5));
  var title = script.getAttribute('data-title') || 'Latest posts';
  var origin = ${JSON.stringify(origin)};
  fetch(origin + '/api/widget?count=' + count)
    .then(function(r){ return r.json(); })
    .then(function(d){
      var posts = (d && d.posts) || [];
      var wrap = document.createElement('div');
      wrap.style.cssText = 'font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937';
      var h3 = document.createElement('h3');
      h3.style.cssText = 'margin:0 0 12px;font-size:16px;font-weight:600';
      h3.textContent = title;
      wrap.appendChild(h3);
      var ul = document.createElement('ul');
      ul.style.cssText = 'list-style:none;padding:0;margin:0';
      posts.forEach(function(p){
        var li = document.createElement('li');
        li.style.cssText = 'margin:0 0 10px;padding:0';
        var a = document.createElement('a');
        a.href = origin + '/blog/' + encodeURIComponent(p.slug);
        a.target = '_blank';
        a.rel = 'noopener';
        a.style.cssText = 'color:#0ea5e9;text-decoration:none;font-weight:500';
        a.textContent = p.title || '';
        li.appendChild(a);
        if (p.meta_description) {
          var meta = document.createElement('div');
          meta.style.cssText = 'color:#6b7280;font-size:12px;margin-top:2px';
          meta.textContent = String(p.meta_description).slice(0, 140);
          li.appendChild(meta);
        }
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      target.replaceChildren(wrap);
    })
    .catch(function(){ target.replaceChildren(); });
})();`;
  return new Response(js, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
      'access-control-allow-origin': '*',
    },
  });
};
