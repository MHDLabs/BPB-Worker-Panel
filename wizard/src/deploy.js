/**
 * Cloudflare API helpers for deploying BPB Worker Panel.
 * Compatible with official BPB deployment flow:
 * - Create KV namespace and bind as "kv"
 * - Inject EMBEDED_SETTINGS (accID, accEmail, apiToken, vlUUID, trPass, securePath, mainDomain)
 * - Optional Durable Object (SESSIONS / WebProxySession) for TWP compatibility
 * - Return panel login URL + account email
 */

import { obfuscateWorkerCode } from "./obfuscate.js";

const CF_API = "https://api.cloudflare.com/client/v4";
const WORKER_JS_URL =
  "https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/latest/download/worker.js";
const TWP_MIGRATION_TAG = "v1-twp";

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
  return {
    id: accounts.result[0].id,
    email: (user.result?.email || "").toLowerCase(),
  };
}

export async function nameTaken(token, accountId, name) {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${name}`,
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

export function randomUUID() {
  return crypto.randomUUID();
}

export function randomPass() {
  return randomString(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.",
    16,
    32
  );
}

export function randomSecurePath() {
  return randomString(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    16,
    32
  );
}

async function getWorkersSubdomain(token, accountId) {
  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success || !data.result?.subdomain) {
    // Try to enable / create subdomain
    const put = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subdomain: "bpb" + Math.random().toString(36).slice(2, 8) }),
    });
    const putData = await put.json();
    if (putData.success && putData.result?.subdomain) return putData.result.subdomain;
    throw new Error("نتوانستم workers.dev subdomain اکانت را بگیرم");
  }
  return data.result.subdomain;
}

async function createKVNamespace(token, accountId, title) {
  const res = await fetch(`${CF_API}/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  const data = await res.json();
  if (!data.success || !data.result?.id) {
    throw new Error(
      "ساخت KV ناموفق: " + (data.errors?.[0]?.message || JSON.stringify(data.errors || data))
    );
  }
  return data.result.id;
}

async function getWorkerMigrationTag(token, accountId, scriptName) {
  try {
    const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success || !Array.isArray(data.result)) return null;
    const entry = data.result.find((s) => s?.id === scriptName);
    const tag = entry?.migration_tag;
    return typeof tag === "string" && tag.trim() ? tag.trim() : null;
  } catch {
    return null;
  }
}

async function fetchWorkerScript() {
  const res = await fetch(WORKER_JS_URL, {
    headers: { "User-Agent": "BPB-Wizard/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`دانلود worker.js ناموفق (${res.status})`);
  const text = await res.text();
  if (!text || text.length < 1000) throw new Error("فایل worker.js ناقص است");
  return text;
}

function buildEmbeddedScript(raw, settings) {
  const settingsJSON = JSON.stringify(settings);
  const ts = new Date().toISOString();
  return `// ${settings.accEmail}\n// ${ts}\n// @ts-nocheck\nconst EMBEDED_SETTINGS = ${settingsJSON};\n${raw}`;
}

export async function deployWorker(
  token,
  accountId,
  accountEmail,
  workerName,
  onProgress,
  options = {}
) {
  onProgress?.("در حال دریافت workers.dev subdomain...");
  const cfSubdomain = await getWorkersSubdomain(token, accountId);
  const mainDomain = `${workerName}.${cfSubdomain}.workers.dev`;

  onProgress?.("در حال ساخت KV Namespace...");
  const kvId = await createKVNamespace(token, accountId, `bpb-${workerName}`);

  onProgress?.("در حال دانلود آخرین worker.js از ریلیز رسمی...");
  let raw = await fetchWorkerScript();

  const vlUUID = randomUUID();
  const trPass = randomPass();
  const securePath = randomSecurePath();

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

  onProgress?.("در حال تزریق تنظیمات پنل (EMBEDED_SETTINGS)...");
  let script = buildEmbeddedScript(raw, settings);

  if (options.obfuscate !== false) {
    onProgress?.("در حال مبهم‌سازی کد (jasaz-style)...");
    script = obfuscateWorkerCode(script);
  }

  if (options.force) {
    onProgress?.("حذف Worker قبلی (force)...");
    try {
      await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (_) {}
  }

  onProgress?.("در حال آماده‌سازی metadata و bindings...");
  const existingTag = await getWorkerMigrationTag(token, accountId, workerName);

  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "kv_namespace", name: "kv", namespace_id: kvId },
      {
        type: "durable_object_namespace",
        name: "SESSIONS",
        class_name: "WebProxySession",
      },
    ],
    // Keep existing secrets/bindings on update when possible
    keep_bindings: ["secret_text"],
  };

  if (!existingTag) {
    metadata.migrations = {
      new_tag: TWP_MIGRATION_TAG,
      new_sqlite_classes: ["WebProxySession"],
    };
  } else {
    metadata.migrations = {
      old_tag: existingTag,
      new_tag: existingTag,
    };
  }

  onProgress?.("در حال آپلود Worker به Cloudflare...");
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
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
      "آپلود Worker ناموفق: " +
        (putData.errors?.[0]?.message || JSON.stringify(putData.errors || putData))
    );
  }

  onProgress?.("فعال‌سازی ساب‌دامین workers.dev...");
  await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    }
  );

  const panelBase = `https://${mainDomain}`;
  const loginUrl = `${panelBase}/${securePath}/login`;
  const panelUrl = `${panelBase}/${securePath}/panel`;

  return {
    workerName,
    mainDomain,
    loginUrl,
    panelUrl,
    email: accountEmail,
    securePath,
    vlUUID,
    // do not return apiToken or raw secret passwords beyond what's needed
  };
}

/** Lightweight health check of a deployed panel login page */
export async function probeWorker(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "BPB-Wizard-Probe/1.0" },
    });
    return {
      ok: res.status >= 200 && res.status < 500,
      status: res.status,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}
