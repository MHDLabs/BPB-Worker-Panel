/**
 * Simple BPB Panel Deployer Wizard (Cloudflare Worker)
 * Inspired by BPB-Wizard, jasaz, and TWP-CF patterns.
 * Serves a lightweight UI to deploy Workers via Cloudflare API.
 */

const HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BPB Simple Wizard</title>
  <style>
    :root { --bg:#0b0e13; --panel:#141a22; --text:#e7edf4; --muted:#8a96a5; --blue:#4d9fff; --green:#46d98b; --red:#ff6570; --line:#29323e; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px; }
    .wrap { max-width: 520px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    p { color: var(--muted); font-size: 0.9rem; margin-bottom: 20px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 6px; }
    input, select, textarea { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: #0a0e13; color: var(--text); margin-bottom: 14px; font-size: 0.95rem; }
    button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: var(--blue); color: #fff; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .log { background: #0a0e13; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 0.8rem; max-height: 200px; overflow-y: auto; white-space: pre-wrap; margin-top: 12px; display: none; }
    .ok { color: var(--green); }
    .err { color: var(--red); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>BPB Simple Wizard</h1>
    <p>دیپلویر ساده ورکر روی Cloudflare — برای تست و استقرار سریع</p>
    <div class="card">
      <label>Account ID</label>
      <input id="accountId" placeholder="3a4b24d1..." value="">
      <label>API Token</label>
      <input id="token" type="password" placeholder="cfut_...">
      <label>Worker Name (کوتاه)</label>
      <input id="name" value="bpb-wiz" placeholder="bpb-wiz">
      <label>Script (کد ورکر — برای تست ساده)</label>
      <textarea id="script" rows="6">export default { async fetch(req) { return new Response("BPB Wizard is alive! " + new Date().toISOString(), { headers: { "content-type": "text/plain; charset=utf-8" } }); } }</textarea>
      <button id="deploy">Deploy Worker</button>
      <div id="log" class="log"></div>
    </div>
  </div>
  <script>
    const $ = id => document.getElementById(id);
    const log = (msg, cls="") => { const el = $("log"); el.style.display="block"; el.innerHTML += (cls ? \`<span class="\${cls}">\${msg}</span>\` : msg) + "\\n"; el.scrollTop = el.scrollHeight; };
    $("deploy").onclick = async () => {
      const accountId = $("accountId").value.trim();
      const token = $("token").value.trim();
      const name = $("name").value.trim() || "bpb-wiz";
      const script = $("script").value;
      if (!accountId || !token) { log("Account ID و Token لازم است", "err"); return; }
      $("deploy").disabled = true;
      log("در حال دیپلوی...");
      try {
        // Upload script as module
        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2024-09-23" })], { type: "application/json" }));
        form.append("worker.js", new Blob([script], { type: "application/javascript+module" }));
        const res = await fetch(\`https://api.cloudflare.com/client/v4/accounts/\${accountId}/workers/scripts/\${name}\`, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + token },
          body: form
        });
        const data = await res.json();
        if (data.success) {
          log("✓ دیپلوی موفق: https://" + name + "." + (data.result?.id || "workers.dev"), "ok");
          // Enable workers.dev subdomain
          await fetch(\`https://api.cloudflare.com/client/v4/accounts/\${accountId}/workers/scripts/\${name}/subdomain\`, {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: true })
          });
          log("✓ ساب‌دامین workers.dev فعال شد", "ok");
          log("آدرس: https://" + name + ".workers.dev", "ok");
        } else {
          log("خطا: " + JSON.stringify(data.errors || data), "err");
        }
      } catch (e) {
        log("خطا: " + e.message, "err");
      }
      $("deploy").disabled = false;
    };
  </script>
</body>
</html>`;

export default {
  async fetch(request) {
    return new Response(HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
