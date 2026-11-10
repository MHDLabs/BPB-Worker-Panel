/**
 * Auto-deployer for a single fixed Worker + KV (iot-test).
 * Script source: MHDLabs release `_worker.js` (pre-obfuscated).
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const WORKER_URL =
  "https://github.com/MHDLabs/BPB-Worker-Panel/releases/latest/download/_worker.js";
const FIXED_NAME = "iot-test";
const TWP_MIGRATION_TAG = "v1-twp";

export { FIXED_NAME };

export async function verifyToken(token) {
  const res = await fetch(`${CF_API}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success || data.result?.status !== "active") {
    throw new Error("API Token is invalid or inactive");
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
    throw new Error("No account found for this token");
  }
  const email = (user.result?.email || "").toLowerCase();
  if (!email) throw new Error("Account email unavailable (need user_details:read)");
  return { id: accounts.result[0].id, email };
}

export async function nameTaken(token, accountId, name = FIXED_NAME) {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.status === 200;
}


function generateProxySecret() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function setWorkerSecret(token, accountId, scriptName, name, text, onProgress) {
  onProgress?.(`Setting ${name}...`);
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, text, type: "secret_text" }),
    }
  );
  const data = await res.json();
  if (!data.success) {
    throw new Error(
      `Failed to set ${name}: ` + (data.errors?.[0]?.message || JSON.stringify(data.errors || data))
    );
  }
  return true;
}

function randomString(charset, min, max) {
  const len = min + Math.floor(Math.random() * (max - min + 1));
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += charset[bytes[i] % charset.length];
  return out;
}

async function getOrCreateWorkersSubdomain(token, accountId, onProgress) {
  const headers = { Authorization: `Bearer ${token}` };
  const getRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, { headers });
  const getData = await getRes.json();
  if (getData.success && getData.result?.subdomain) return getData.result.subdomain;

  onProgress?.("Creating workers.dev subdomain...");
  for (let i = 0; i < 5; i++) {
    const sub = "svc" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 6, 8);
    const putRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: sub }),
    });
    const putData = await putRes.json();
    if (putData.success && putData.result?.subdomain) return putData.result.subdomain;
  }
  throw new Error("Failed to create workers.dev subdomain");
}

async function listKVNamespaces(token, accountId) {
  const headers = { Authorization: `Bearer ${token}` };
  const all = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `${CF_API}/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
      { headers }
    );
    const data = await res.json();
    if (!data.success) break;
    const batch = data.result || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function deleteKVNamespace(token, accountId, namespaceId) {
  await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Ensure exactly one KV titled FIXED_NAME.
 * Reuse if present; otherwise create. Optionally wipe+recreate.
 */
async function ensureKV(token, accountId, { reset = false } = {}, onProgress) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const list = await listKVNamespaces(token, accountId);
  const existing = list.filter((n) => n.title === FIXED_NAME);

  if (reset) {
    onProgress?.("Resetting storage namespace...");
    for (const n of existing) {
      await deleteKVNamespace(token, accountId, n.id);
    }
  } else if (existing.length === 1) {
    onProgress?.("Reusing existing storage namespace...");
    return existing[0].id;
  } else if (existing.length > 1) {
    onProgress?.("Cleaning duplicate storage namespaces...");
    for (let i = 1; i < existing.length; i++) {
      await deleteKVNamespace(token, accountId, existing[i].id);
    }
    return existing[0].id;
  }

  onProgress?.("Creating storage namespace...");
  const res = await fetch(`${CF_API}/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: FIXED_NAME }),
  });
  const data = await res.json();
  if (!data.success || !data.result?.id) {
    // race: already exists
    const again = (await listKVNamespaces(token, accountId)).find((n) => n.title === FIXED_NAME);
    if (again) return again.id;
    throw new Error(
      "Failed to create storage: " + (data.errors?.[0]?.message || JSON.stringify(data.errors))
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
  const res = await fetch(WORKER_URL, {
    headers: { "User-Agent": "AutoDeployer/3.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Failed to download script (${res.status})`);
  const text = await res.text();
  if (!text || text.length < 1000) throw new Error("Script file incomplete");
  return text;
}

function buildEmbeddedScript(raw, settings) {
  const ts = new Date().toISOString();
  return `// ${settings.accEmail}\n// Build: ${ts}\n// @ts-nocheck\nconst EMBEDED_SETTINGS = ${JSON.stringify(settings)};\n${raw}`;
}

export async function deleteWorker(token, accountId, onProgress) {
  onProgress?.("Removing service...");
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(FIXED_NAME)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  // 404 is ok
  if (res.status !== 200 && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    if (data.success === false) {
      throw new Error(data.errors?.[0]?.message || "Delete failed");
    }
  }
  return true;
}

/**
 * Deploy or update the single fixed worker.
 * @param {{ resetStorage?: boolean, force?: boolean }} options
 */
export async function deployWorker(
  token,
  accountId,
  accountEmail,
  onProgress,
  options = {}
) {
  const workerName = FIXED_NAME;

  if (options.force) {
    await deleteWorker(token, accountId, onProgress);
  }

  onProgress?.("Resolving workers.dev subdomain...");
  const cfSub = await getOrCreateWorkersSubdomain(token, accountId, onProgress);
  const mainDomain = `${workerName}.${cfSub}.workers.dev`;

  const kvId = await ensureKV(
    token,
    accountId,
    { reset: !!options.resetStorage },
    onProgress
  );

  onProgress?.("Downloading service script...");
  const raw = await fetchWorkerScript();

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

  onProgress?.("Applying configuration...");
  const script = buildEmbeddedScript(raw, settings);

  onProgress?.("Preparing bindings...");
  const existingTag = await getWorkerMigrationTag(token, accountId, workerName);
  const metadata = {
    main_module: "worker.js",
    compatibility_date: new Date().toISOString().split("T")[0],
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "kv_namespace", name: "kv", namespace_id: kvId },
      {
        type: "durable_object_namespace",
        name: "SESSIONS",
        class_name: "WebProxySession",
      },
    ],
    keep_bindings: ["secret_text"],
  };
  if (!existingTag) {
    metadata.migrations = {
      new_tag: TWP_MIGRATION_TAG,
      new_sqlite_classes: ["WebProxySession"],
    };
  } else {
    metadata.migrations = { old_tag: existingTag, new_tag: existingTag };
  }

  onProgress?.("Uploading service...");
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
      "Upload failed: " + (putData.errors?.[0]?.message || JSON.stringify(putData.errors || putData))
    );
  }

  // Telegram Web Proxy secret (32 hex) — required by env.PROXY_SECRET
  const proxySecret = generateProxySecret();
  await setWorkerSecret(
    token,
    accountId,
    workerName,
    "PROXY_SECRET",
    proxySecret,
    onProgress
  );

  onProgress?.("Enabling workers.dev route...");
  await fetch(
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

  const panelBase = `https://${mainDomain}`;
  const panelUrl = `${panelBase}/${securePath}/panel`;
  const loginUrl = `${panelBase}/${securePath}/login`;

  onProgress?.("Checking login page...");
  let probeOk = false;
  for (let i = 0; i < 5; i++) {
    try {
      const pr = await fetch(loginUrl, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "AutoDeployer-Probe/3.0" },
      });
      if (pr.status >= 200 && pr.status < 500) {
        probeOk = true;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 700));
  }

  const connectionUrl = `https://t.me/webproxy?server=${encodeURIComponent(mainDomain)}&secret=${encodeURIComponent(proxySecret)}`;

  return {
    workerName,
    mainDomain,
    loginUrl,
    panelUrl,
    email: accountEmail,
    securePath,
    probeOk,
    kvId,
    proxySecret,
    connectionUrl,
  };
}

export async function probeWorker(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "AutoDeployer-Probe/3.0" },
    });
    return { ok: res.status >= 200 && res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}
