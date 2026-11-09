import {
  verifyToken,
  getAccount,
  nameTaken,
  randomName,
  deployWorker,
  probeWorker,
} from "./deploy.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": url.origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/api/deploy" && request.method === "POST") {
      return streamDeploy(request, url);
    }

    if (url.pathname === "/api/probe" && request.method === "POST") {
      return jsonAction(request, async (body) => {
        if (!body.url) throw new Error("url الزامی است");
        return probeWorker(body.url);
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response(HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function jsonAction(request, fn) {
  try {
    const body = await request.json();
    const result = await fn(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ ok: false, error: err.message || String(err) }, { status: 400 });
  }
}

function streamDeploy(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

  (async () => {
    try {
      const body = await request.json();
      const token = (body.token || "").trim();
      if (!token) {
        await send({ type: "error", message: "API Token الزامی است" });
        return;
      }

      await send({ type: "info", message: "در حال بررسی Token..." });
      await verifyToken(token);

      await send({ type: "info", message: "در حال دریافت اطلاعات اکانت..." });
      const account = await getAccount(token);
      if (!account.email) {
        await send({ type: "error", message: "ایمیل اکانت Cloudflare در دسترس نیست" });
        return;
      }
      await send({ type: "info", message: `اکانت: ${account.email}` });

      let workerName = (body.name || "").trim().toLowerCase();
      if (workerName) {
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
          await send({ type: "error", message: "نام Worker نامعتبر است" });
          return;
        }
        if (!body.force && (await nameTaken(token, account.id, workerName))) {
          await send({
            type: "error",
            message: `نام «${workerName}» قبلاً استفاده شده — برای جایگزینی گزینه force را فعال کنید`,
          });
          return;
        }
      } else {
        do {
          workerName = randomName();
        } while (await nameTaken(token, account.id, workerName));
      }

      await send({ type: "info", message: `نام Worker: ${workerName}` });

      const result = await deployWorker(
        token,
        account.id,
        account.email,
        workerName,
        async (msg) => {
          await send({ type: "info", message: msg });
        },
        { obfuscate: body.obfuscate !== false, force: !!body.force }
      );

      await send({
        type: "complete",
        url: result.loginUrl,
        panelUrl: result.panelUrl,
        workerName: result.workerName,
        email: result.email,
        accountId: account.id,
        mainDomain: result.mainDomain,
        securePath: result.securePath,
      });
    } catch (err) {
      await send({ type: "error", message: err.message || String(err) });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Access-Control-Allow-Origin": url.origin,
      "Cache-Control": "no-store",
    },
  });
}

const HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>BPB Panel Deployer</title>
  <style>
    :root {
      --bg0: #05060a;
      --bg1: #0b0d14;
      --glass: rgba(255,255,255,0.06);
      --glass2: rgba(255,255,255,0.1);
      --stroke: rgba(255,255,255,0.14);
      --text: #f4f6fb;
      --muted: #9aa3b5;
      --accent: #5b8cff;
      --accent2: #7c5cff;
      --ok: #34d399;
      --err: #fb7185;
      --term: #22c55e;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; }
    body {
      font-family: system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(91,140,255,0.25), transparent 55%),
        radial-gradient(900px 500px at 90% 0%, rgba(124,92,255,0.22), transparent 50%),
        radial-gradient(700px 400px at 50% 100%, rgba(52,211,153,0.08), transparent 45%),
        linear-gradient(180deg, var(--bg0), var(--bg1));
      background-attachment: fixed;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
      opacity: 0.35;
      mix-blend-mode: soft-light;
      z-index: 0;
    }
    .blob {
      position: fixed;
      width: 42vw;
      height: 42vw;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0.35;
      z-index: 0;
      animation: float 12s ease-in-out infinite;
    }
    .blob.a { top: -10%; right: -8%; background: #5b8cff; }
    .blob.b { bottom: -15%; left: -10%; background: #7c5cff; animation-delay: -4s; }
    @keyframes float {
      0%,100% { transform: translate3d(0,0,0) scale(1); }
      50% { transform: translate3d(2%, 3%, 0) scale(1.08); }
    }
    main {
      position: relative;
      z-index: 1;
      width: min(520px, 100%);
      margin: 0 auto;
      padding: 2.5rem 1.1rem 3.5rem;
    }
    .hero {
      text-align: center;
      margin-bottom: 1.6rem;
      animation: rise 0.7s cubic-bezier(.2,.8,.2,1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(18px) scale(0.98); filter: blur(6px); }
      to { opacity: 1; transform: none; filter: none; }
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.28rem 0.7rem;
      border-radius: 999px;
      background: var(--glass);
      border: 1px solid var(--stroke);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 0.85rem;
    }
    .badge i {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 12px var(--ok);
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.85); }
    }
    h1 {
      font-size: clamp(1.6rem, 4vw, 2rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #fff 20%, #b7c7ff 55%, #d2b7ff 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      margin-bottom: 0.35rem;
    }
    .sub { color: var(--muted); font-size: 0.92rem; }

    .glass {
      background: linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.04));
      border: 1px solid var(--stroke);
      border-radius: 22px;
      backdrop-filter: blur(28px) saturate(160%);
      -webkit-backdrop-filter: blur(28px) saturate(160%);
      box-shadow:
        0 20px 60px rgba(0,0,0,0.35),
        inset 0 1px 0 rgba(255,255,255,0.12);
      padding: 1.15rem;
      margin-bottom: 1rem;
      animation: rise 0.8s cubic-bezier(.2,.8,.2,1) both;
      animation-delay: 0.08s;
      transition: transform 0.35s ease, box-shadow 0.35s ease;
    }
    .glass:hover {
      transform: translateY(-2px);
      box-shadow: 0 28px 70px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.16);
    }

    label {
      display: block;
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 0.35rem;
    }
    .field { margin-bottom: 0.9rem; position: relative; }
    input {
      width: 100%;
      padding: 0.85rem 0.95rem;
      border-radius: 14px;
      border: 1px solid var(--stroke);
      background: rgba(0,0,0,0.25);
      color: var(--text);
      font-size: 0.95rem;
      font-family: var(--mono);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    input:focus {
      border-color: rgba(91,140,255,0.55);
      box-shadow: 0 0 0 4px rgba(91,140,255,0.15);
      background: rgba(0,0,0,0.35);
    }
    input::placeholder { color: #5c6578; }
    .eye {
      position: absolute;
      left: 0.7rem;
      top: 2.05rem;
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0.2rem 0.4rem;
    }

    .btn {
      width: 100%;
      padding: 0.9rem 1rem;
      border: none;
      border-radius: 14px;
      font-size: 0.98rem;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      box-shadow: 0 10px 30px rgba(91,140,255,0.3);
      transition: transform 0.2s, box-shadow 0.2s, filter 0.2s;
      position: relative;
      overflow: hidden;
    }
    .btn::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%);
      transform: translateX(-120%);
      transition: transform 0.6s ease;
    }
    .btn:hover:not(:disabled)::after { transform: translateX(120%); }
    .btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 14px 36px rgba(91,140,255,0.4);
    }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; filter: grayscale(0.2); }
    .btn.ghost {
      background: rgba(255,255,255,0.06);
      box-shadow: none;
      border: 1px solid var(--stroke);
      color: var(--text);
      font-weight: 500;
      font-size: 0.82rem;
      padding: 0.55rem 0.75rem;
      width: auto;
    }
    .btn.danger {
      background: linear-gradient(135deg, #fb7185, #e11d48);
      box-shadow: 0 8px 22px rgba(225,29,72,0.25);
    }
    .btn.ok {
      background: linear-gradient(135deg, #34d399, #059669);
      box-shadow: 0 8px 22px rgba(5,150,105,0.25);
    }
    .btn.sm { width: auto; padding: 0.45rem 0.7rem; font-size: 0.78rem; border-radius: 10px; }

    .term {
      display: none;
      margin-top: 0.2rem;
      border-radius: 16px;
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(34,197,94,0.2);
      box-shadow: inset 0 0 40px rgba(34,197,94,0.05);
      overflow: hidden;
      animation: rise 0.5s ease both;
    }
    .term.visible { display: block; }
    .term-bar {
      display: flex;
      gap: 6px;
      padding: 0.65rem 0.85rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
    }
    .term-bar span {
      width: 10px; height: 10px; border-radius: 50%;
      background: #3a3f4b;
    }
    .term-bar span:nth-child(1) { background: #ff5f57; }
    .term-bar span:nth-child(2) { background: #febc2e; }
    .term-bar span:nth-child(3) { background: #28c840; }
    .term-body {
      padding: 0.85rem 1rem;
      font-family: var(--mono);
      font-size: 0.78rem;
      line-height: 1.65;
      max-height: 210px;
      overflow-y: auto;
      color: var(--term);
      text-shadow: 0 0 8px rgba(34,197,94,0.25);
    }
    .term-body .err { color: var(--err); text-shadow: 0 0 8px rgba(251,113,133,0.25); }
    .term-body .line::before { content: "> "; opacity: 0.55; }

    .history-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.85rem;
      color: var(--muted);
      font-size: 0.9rem;
      font-weight: 600;
    }
    .card {
      border-radius: 16px;
      border: 1px solid var(--stroke);
      background: rgba(0,0,0,0.22);
      padding: 0.9rem;
      margin-bottom: 0.75rem;
      transition: border-color 0.25s, transform 0.25s;
      animation: rise 0.55s ease both;
    }
    .card:hover { border-color: rgba(91,140,255,0.35); transform: translateY(-1px); }
    .card .top {
      display: flex;
      justify-content: space-between;
      gap: 0.6rem;
      margin-bottom: 0.55rem;
      align-items: baseline;
    }
    .card .name {
      font-weight: 650;
      font-size: 0.95rem;
      letter-spacing: -0.01em;
    }
    .card .email { font-size: 0.75rem; color: var(--muted); direction: ltr; text-align: left; }
    .card .time { font-size: 0.72rem; color: var(--muted); }
    .link-row {
      display: flex;
      gap: 0.45rem;
      align-items: center;
      margin-bottom: 0.7rem;
    }
    .link-row code {
      flex: 1;
      font-family: var(--mono);
      font-size: 0.72rem;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--stroke);
      border-radius: 10px;
      padding: 0.5rem 0.6rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
      text-align: left;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .status {
      font-size: 0.75rem;
      margin-top: 0.55rem;
      color: var(--muted);
      min-height: 1.1em;
    }
    .status.ok { color: var(--ok); }
    .status.bad { color: var(--err); }
    .empty {
      text-align: center;
      color: var(--muted);
      font-size: 0.85rem;
      padding: 0.6rem 0 0.2rem;
    }
    .repo {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.85rem;
      padding: 0.4rem 0.75rem;
      border-radius: 999px;
      border: 1px solid var(--stroke);
      background: rgba(255,255,255,0.05);
      color: var(--muted);
      font-size: 0.78rem;
      text-decoration: none;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
      direction: ltr;
    }
    .repo:hover {
      color: var(--text);
      border-color: rgba(255,255,255,0.28);
      background: rgba(255,255,255,0.08);
    }
    .token-btn {
      width: 100%;
      margin-bottom: 0.9rem;
      padding: 0.75rem 1rem;
      border-radius: 14px;
      border: 1px solid rgba(91,140,255,0.35);
      background: linear-gradient(135deg, rgba(91,140,255,0.18), rgba(124,92,255,0.12));
      color: #c9d7ff;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      box-shadow: 0 8px 24px rgba(91,140,255,0.12);
    }
    .token-btn:hover {
      transform: translateY(-1px);
      border-color: rgba(91,140,255,0.55);
      box-shadow: 0 12px 30px rgba(91,140,255,0.2);
      color: #fff;
    }
    .token-btn svg { flex-shrink: 0; opacity: 0.9; }
    .check {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.8rem;
      color: var(--muted);
      margin: 0 0 0.55rem;
      cursor: pointer;
      user-select: none;
    }
    .check input { width: auto; margin: 0; accent-color: var(--accent); }
    .hint {
      text-align: center;
      font-size: 0.78rem;
      color: var(--muted);
      margin-top: 0.4rem;
      animation: rise 0.9s ease both;
    }
  .hidden{display:none!important}
  </style>
</head>
<body>
  <div class="blob a"></div>
  <div class="blob b"></div>
  <main>
    <div class="hero">
      <div class="badge"><i></i> BPB Panel One-Click Deploy</div>
      <h1>دیپلوی خودکار</h1>
      <p class="sub">پنل BPB روی Cloudflare Workers</p>
      <a class="repo" href="https://github.com/MHDLabs/BPB-Worker-Panel" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        github.com/MHDLabs/BPB-Worker-Panel
      </a>
    </div>

    <section class="glass">
      <form id="form">
        <a class="token-btn" href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=BPB-Wizard" target="_blank" rel="noopener">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" fill="currentColor" opacity=".9"/><path d="M18.5 14l.75 2.25L21.5 17l-2.25.75L18.5 20l-.75-2.25L15.5 17l2.25-.75L18.5 14z" fill="currentColor" opacity=".7"/></svg>
          دریافت Token با دسترسی‌های لازم
        </a>
        <div class="field">
          <label for="token">Cloudflare API Token</label>
          <input id="token" type="password" placeholder="Token را وارد کنید" required autocomplete="off" spellcheck="false">
          <button type="button" class="eye" id="toggle-token">نمایش</button>
        </div>
        <div class="field">
          <label for="name">نام Worker (اختیاری)</label>
          <input id="name" type="text" placeholder="خالی = تصادفی" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autocomplete="off">
        </div>
        <label class="check"><input type="checkbox" id="force"> جایگزینی Worker هم‌نام (force)</label>
        <label class="check"><input type="checkbox" id="obfuscate" checked> مبهم‌سازی کد (jasaz)</label>
        <button class="btn" type="submit" id="btn">شروع دیپلوی</button>
      </form>

      <div class="term" id="term">
        <div class="term-bar"><span></span><span></span><span></span></div>
        <div class="term-body" id="log"></div>
      </div>
    </section>

    
    <section class="glass hidden" id="result">
      <div class="history-title"><span>نتیجه دیپلوی</span></div>
      <div class="item-row"><span>ایمیل لاگین پنل</span><code id="rEmail">—</code></div>
      <div class="item-row"><span>لینک ورود پنل</span><code id="rLogin">—</code></div>
      <div class="item-row"><span>آدرس پنل</span><code id="rPanel">—</code></div>
      <div class="item-row"><span>نام Worker</span><code id="rWorker">—</code></div>
      <div class="item-row"><span>دامنه</span><code id="rDomain">—</code></div>
      <p class="hint" style="margin:0.6rem 0 0.8rem">برای ورود از <strong>ایمیل اکانت Cloudflare</strong> استفاده کنید و در اولین ورود رمز دلخواه بگذارید.</p>
      <div class="item-actions">
        <button type="button" class="btn sm" id="openUrl">باز کردن صفحه ورود</button>
        <button type="button" class="btn ghost sm" id="copyLogin">کپی لینک ورود</button>
        <button type="button" class="btn ghost sm" id="copyEmail">کپی ایمیل</button>
      </div>
    </section>

<section class="glass" id="history-wrap">
      <div class="history-title">
        <span>دیپلوی‌های این مرورگر</span>
        <span style="display:flex;gap:0.35rem;flex-wrap:wrap">
          <button type="button" class="btn ghost sm" id="export-hist">خروجی</button>
          <button type="button" class="btn ghost sm" id="import-hist">ورودی</button>
          <button type="button" class="btn ghost sm" id="clear-all">پاک‌سازی</button>
        </span>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <div id="history"></div>
    </section>

    <p class="hint">Token و تاریخچه دیپلوی فقط در همین مرورگر ذخیره می‌شود</p>
  </main>

  <script>
    const KEY_DEPLOYS = "bpb-panel-deploys-v3";
    const KEY_TOKEN = "bpb-panel-token";

    const tokenInput = document.getElementById("token");
    const nameInput = document.getElementById("name");
    const forceInput = document.getElementById("force");
    const obfuscateInput = document.getElementById("obfuscate");
    const deployBtn = document.getElementById("btn");
    const formEl = document.getElementById("form");
    const logEl = document.getElementById("log");
    const historyEl = document.getElementById("history");
    const resultCard = document.getElementById("result");

    const savedToken = localStorage.getItem(KEY_TOKEN) || "";
    if (savedToken) tokenInput.value = savedToken;

    function loadDeploys() {
      try { return JSON.parse(localStorage.getItem(KEY_DEPLOYS) || "[]"); }
      catch { return []; }
    }
    function saveDeploys(list) {
      localStorage.setItem(KEY_DEPLOYS, JSON.stringify(list.slice(0, 40)));
    }
    function fmtTime(ts) {
      try { return new Date(ts).toLocaleString("fa-IR"); } catch { return ""; }
    }
    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    }
    function logLine(msg, isErr) {
      const line = document.createElement("div");
      line.className = isErr ? "err" : "";
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }
    function token() {
      return (tokenInput.value || "").trim();
    }

    function renderHistory() {
      const list = loadDeploys();
      if (!list.length) {
        historyEl.innerHTML = \`<div class="empty">هنوز دیپلویی ذخیره نشده</div>\`;
        return;
      }
      historyEl.innerHTML = list.map((d, i) => \`
        <div class="item" data-i="\${i}">
          <div class="item-top">
            <strong>\${esc(d.workerName || d.name || "worker")}</strong>
            <span class="muted">\${esc(fmtTime(d.ts))}</span>
          </div>
          <div class="item-row">
            <span>ایمیل لاگین</span>
            <code title="\${esc(d.email)}">\${esc(d.email || "—")}</code>
          </div>
          <div class="item-row">
            <span>لینک ورود پنل</span>
            <code title="\${esc(d.url)}">\${esc(d.url || "—")}</code>
          </div>
          <div class="item-actions">
            <button type="button" class="btn ghost sm" data-act="copy-url" data-i="\${i}">کپی لینک</button>
            <button type="button" class="btn ghost sm" data-act="copy-email" data-i="\${i}">کپی ایمیل</button>
            <button type="button" class="btn ghost sm" data-act="open" data-i="\${i}">باز کردن</button>
            <button type="button" class="btn danger sm" data-act="forget" data-i="\${i}">حذف از تاریخچه</button>
          </div>
        </div>
      \`).join("");
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return res.json();
    }

    historyEl.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const list = loadDeploys();
      const d = list[i];
      if (!d) return;
      const act = btn.dataset.act;

      if (act === "copy-url") {
        await navigator.clipboard.writeText(d.url || "");
        btn.textContent = "کپی شد";
        setTimeout(() => btn.textContent = "کپی لینک", 1200);
        return;
      }
      if (act === "copy-email") {
        await navigator.clipboard.writeText(d.email || "");
        btn.textContent = "کپی شد";
        setTimeout(() => btn.textContent = "کپی ایمیل", 1200);
        return;
      }
      if (act === "open") {
        if (d.url) window.open(d.url, "_blank", "noopener");
        return;
      }
      if (act === "forget") {
        list.splice(i, 1);
        saveDeploys(list);
        document.getElementById("toggle-token")?.addEventListener("click", () => {
      const isPass = tokenInput.type === "password";
      tokenInput.type = isPass ? "text" : "password";
      document.getElementById("toggle-token").textContent = isPass ? "پنهان" : "نمایش";
    });
    renderHistory();
        return;
      }
    });

    document.getElementById("clear-all")?.addEventListener("click", () => {
      if (confirm("تاریخچه محلی پاک شود؟ (ورکرها روی Cloudflare حذف نمی‌شوند)")) {
        localStorage.removeItem(KEY_DEPLOYS);
        document.getElementById("toggle-token")?.addEventListener("click", () => {
      const isPass = tokenInput.type === "password";
      tokenInput.type = isPass ? "text" : "password";
      document.getElementById("toggle-token").textContent = isPass ? "پنهان" : "نمایش";
    });
    renderHistory();
      }
    });

    formEl.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const t = token();
      if (!t) { alert("API Token را وارد کنید"); return; }
      localStorage.setItem(KEY_TOKEN, t);
      deployBtn.disabled = true;
      logEl.innerHTML = "";
      if (resultCard) resultCard.classList.add("hidden");

      try {
        const res = await fetch("/api/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: t,
            name: (nameInput.value || "").trim(),
            force: !!(forceInput && forceInput.checked),
            obfuscate: obfuscateInput ? !!obfuscateInput.checked : true,
          }),
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("
");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.type === "info") logLine(msg.message);
            else if (msg.type === "error") logLine(msg.message, true);
            else if (msg.type === "complete") {
              logLine("✓ دیپلوی کامل شد");
              const entry = {
                workerName: msg.workerName,
                url: msg.url,
                panelUrl: msg.panelUrl,
                email: msg.email,
                accountId: msg.accountId,
                mainDomain: msg.mainDomain,
                securePath: msg.securePath,
                ts: Date.now(),
              };
              const list = loadDeploys();
              list.unshift(entry);
              saveDeploys(list);
              document.getElementById("toggle-token")?.addEventListener("click", () => {
      const isPass = tokenInput.type === "password";
      tokenInput.type = isPass ? "text" : "password";
      document.getElementById("toggle-token").textContent = isPass ? "پنهان" : "نمایش";
    });
    renderHistory();
              showResult(entry);
            }
          }
        }
      } catch (err) {
        logLine(err.message || String(err), true);
      } finally {
        deployBtn.disabled = false;
      }
    });

    function showResult(d) {
      if (!resultCard) return;
      resultCard.classList.remove("hidden");
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || "—"; };
      set("rEmail", d.email);
      set("rLogin", d.url);
      set("rPanel", d.panelUrl || d.url);
      set("rWorker", d.workerName);
      set("rDomain", d.mainDomain);
      const openBtn = document.getElementById("openUrl");
      if (openBtn) openBtn.onclick = () => window.open(d.url, "_blank", "noopener");
      const copyLogin = document.getElementById("copyLogin");
      if (copyLogin) copyLogin.onclick = async () => {
        await navigator.clipboard.writeText(d.url || "");
        copyLogin.textContent = "کپی شد";
        setTimeout(() => copyLogin.textContent = "کپی لینک ورود", 1200);
      };
      const copyEmail = document.getElementById("copyEmail");
      if (copyEmail) copyEmail.onclick = async () => {
        await navigator.clipboard.writeText(d.email || "");
        copyEmail.textContent = "کپی شد";
        setTimeout(() => copyEmail.textContent = "کپی ایمیل", 1200);
      };
    }

    document.getElementById("toggle-token")?.addEventListener("click", () => {
      const isPass = tokenInput.type === "password";
      tokenInput.type = isPass ? "text" : "password";
      document.getElementById("toggle-token").textContent = isPass ? "پنهان" : "نمایش";
    });
    renderHistory();
</script>
</body>
</html>
`;
