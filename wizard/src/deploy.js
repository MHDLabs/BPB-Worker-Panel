/**
 * BPB Panel deployer — aligned with official bia-pain-bache/BPB-Wizard
 * + optional jasaz-style obfuscation (itsyebekhe/jasaz).
 */

import { obfuscateWorkerCode } from "./obfuscate.js";

const CF_API = "https://api.cloudflare.com/client/v4";
const WORKER_JS_URL =
  "https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/latest/download/worker.js";

export async function verifyToken(token) {
  const res = await fetch(`${CF_API}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success || data.result?.status !== "active") {
    throw new Error("API Token نامعتبر یا غیرفعال است");
  }
  return data.result;
}

export async function getAccount(token) {
  const [accountsRes, userRes] = await Promise.all([
    fetch(`${CF_API}/accounts`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${CF_API}/user`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);
  const accounts = await accountsRes.json();
  const user = await userRes.json();
  if (!accounts.success || !accounts.result?.length) {
    throw new Error("هیچ اکانتی با این Token پیدا نشد");
  }
  const email = (user.result?.email || "").toLowerCase();
  if (!email) throw new Error("ایمیل اکانت Cloudflare در دسترس نیست (user_details:read لازم است)");
  return { id: accounts.result[0].id, email };
}

export async function nameTaken(token, accountId, name) {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.status === 200;
}

export function randomName() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "bpb-";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomString(charset, min, max) {
  const len = min + Math.floor(Math.random() * (max - min + 1));
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += charset[bytes[i] % charset.length];
  return out;
}

/** workers.dev subdomain like official wizard (get or create) */
async function getOrCreateWorkersSubdomain(token, accountId, onProgress) {
  const headers = { Authorization: `Bearer ${token}` };
  const getRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, { headers });
  const getData = await getRes.json();
  if (getData.success && getData.result?.subdomain) {
    return getData.result.subdomain;
  }

  onProgress?.("ساب‌دامین workers.dev نیست — در حال ساخت...");
  for (let i = 0; i < 5; i++) {
    const sub = "bpb" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 6, 8);
    const putRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: sub }),
    });
    const putData = await putRes.json();
    if (putData.success && putData.result?.subdomain) {
      return putData.result.subdomain;
    }
  }
  throw new Error("ساخت workers.dev subdomain ناموفق بود");
}

async function createKVNamespace(token, accountId, title) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const uniqueTitle =
      attempt === 0 ? title : `${title}-${Date.now().toString(36)}-${randomString("abcdefghijklmnopqrstuvwxyz0123456789", 4, 6)}`;
    const res = await fetch(`${CF_API}/accounts/${accountId}/storage/kv/namespaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: uniqueTitle }),
    });
    const data = await res.json();
    if (data.success && data.result?.id) return data.result.id;
    const msg = data.errors?.[0]?.message || "";
    if (!/already exists/i.test(msg) && attempt === 0) {
      // try unique titles
      continue;
    }
    if (!/already exists/i.test(msg)) {
      throw new Error("ساخت KV ناموفق: " + (msg || JSON.stringify(data.errors || data)));
    }
  }
  throw new Error("ساخت KV ناموفق بعد از چند تلاش");
}

async function fetchWorkerScript() {
  const res = await fetch(WORKER_JS_URL, {
    headers: { "User-Agent": "BPB-Wizard/2.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`دانلود worker.js از ریلیز رسمی ناموفق (${res.status})`);
  const text = await res.text();
  if (!text || text.length < 1000) throw new Error("فایل worker.js ناقص است");
  return text;
}

function buildEmbeddedScript(raw, settings) {
  const settingsJSON = JSON.stringify(settings);
  const ts = new Date().toISOString();
  // same pattern as official BPB-Wizard web buildScript
  return `// ${settings.accEmail}\n// Build: ${ts}\n// @ts-nocheck\nconst EMBEDED_SETTINGS = ${settingsJSON};\n${raw}`;
}

export async function deployWorker(
  token,
  accountId,
  accountEmail,
  workerName,
  onProgress,
  options = {}
) {
  onProgress?.("دریافت workers.dev subdomain...");
  const cfSub = await getOrCreateWorkersSubdomain(token, accountId, onProgress);
  // official mainDomain is name.subdomain without extra .workers.dev duplication when subdomain already includes it
  // API returns just the label e.g. "mhdlab"; full host is name.mhdlab.workers.dev
  const mainDomain = `${workerName}.${cfSub}.workers.dev`;

  onProgress?.("ساخت KV Namespace...");
  const kvId = await createKVNamespace(token, accountId, `bpb-${workerName}`);

  onProgress?.("دانلود آخرین worker.js از ریلیز رسمی BPB...");
  let raw = await fetchWorkerScript();

  const pathCharset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const passCharset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.";
  const securePath = randomString(pathCharset, 12, 16);
  const trPass = randomString(passCharset, 16, 20);
  const vlUUID = crypto.randomUUID();

  const settings = {
    accID: accountId,
    accEmail: accountEmail,
    apiToken: token,
    vlUUID,
    trPass,
    securePath,
    proxyIpMode: "proxyip",
    proxyIPs: [],
    prefixes: [],
    fallback: "",
    dohUrl: "",
    mainDomain,
  };

  onProgress?.("تزریق EMBEDED_SETTINGS (مثل BPB-Wizard رسمی)...");
  let script = buildEmbeddedScript(raw, settings);

  if (options.obfuscate) {
    onProgress?.("مبهم‌سازی jasaz...");
    script = obfuscateWorkerCode(script);
    if (!script || script.length < 1000) {
      throw new Error("خروجی مبهم‌سازی نامعتبر است");
    }
  }

  if (options.force) {
    onProgress?.("حذف Worker قبلی (force)...");
    try {
      await fetch(
        `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (_) {}
  }

  onProgress?.("آپلود Worker (binding: kv)...");
  const metadata = {
    main_module: "worker.js",
    compatibility_date: new Date().toISOString().split("T")[0],
    compatibility_flags: ["nodejs_compat"],
    bindings: [{ type: "kv_namespace", name: "kv", namespace_id: kvId }],
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js"
  );

  const putRes = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }
  );
  const putData = await putRes.json();
  if (!putData.success) {
    throw new Error(
      "آپلود ناموفق: " + (putData.errors?.[0]?.message || JSON.stringify(putData.errors || putData))
    );
  }

  onProgress?.("فعال‌سازی workers.dev...");
  const enRes = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true, previews_enabled: true }),
    }
  );
  const enData = await enRes.json().catch(() => ({}));
  if (enData && enData.success === false) {
    onProgress?.(
      "هشدار: فعال‌سازی subdomain کامل نشد — " + (enData.errors?.[0]?.message || "unknown")
    );
  }

  const panelBase = `https://${mainDomain}`;
  const panelUrl = `${panelBase}/${securePath}/panel`;
  const loginUrl = `${panelBase}/${securePath}/login`;

  // light probe
  onProgress?.("بررسی دسترسی صفحه ورود...");
  let probeOk = false;
  for (let i = 0; i < 4; i++) {
    try {
      const pr = await fetch(loginUrl, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "BPB-Wizard-Probe/2.0" },
      });
      if (pr.status >= 200 && pr.status < 500) {
        probeOk = true;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
  }

  return {
    workerName,
    mainDomain,
    loginUrl,
    panelUrl,
    email: accountEmail,
    securePath,
    probeOk,
  };
}

export async function probeWorker(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "BPB-Wizard-Probe/2.0" },
    });
    return { ok: res.status >= 200 && res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}
