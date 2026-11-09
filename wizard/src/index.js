import {
  verifyToken,
  getAccount,
  nameTaken,
  randomName,
  deployWorker,
  probeWorker,
} from "./deploy.js";

const UI_URL =
  "https://raw.githubusercontent.com/MHDLabs/BPB-Worker-Panel/wizard/wizard/assets/index.html";

let cachedHTML = null;
let cachedAt = 0;

async function getHTML() {
  const now = Date.now();
  if (cachedHTML && now - cachedAt < 60_000) return cachedHTML;
  const res = await fetch(UI_URL, {
    headers: { "User-Agent": "BPB-Wizard/1.1" },
  });
  if (!res.ok) throw new Error("UI fetch failed: " + res.status);
  cachedHTML = await res.text();
  cachedAt = now;
  return cachedHTML;
}

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
      try {
        if (env.ASSETS) {
          const assetRes = await env.ASSETS.fetch(request);
          if (assetRes.ok) return assetRes;
        }
        const html = await getHTML();
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch (e) {
        return new Response("UI unavailable: " + e.message, { status: 500 });
      }
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
            message: `نام «${workerName}» قبلاً استفاده شده — force را فعال کنید`,
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
