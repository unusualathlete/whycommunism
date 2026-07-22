const ALLOWED_ORIGINS = new Set([
  "https://whycommunism.com",
  "https://www.whycommunism.com"
]);

const PATH_PATTERN = /^\/(?:guides|studies|start-here|research)\/[a-z0-9][a-z0-9/-]*\/$/;
const MAX_BODY_BYTES = 1_850_000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGES = 5_000;
const MAX_PREVIEW_HTML_BYTES = 1_250_000;
const GITHUB_API_VERSION = "2022-11-28";

function originFor(request) {
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) return origin;
  return "";
}

function responseHeaders(request) {
  return {
    "Access-Control-Allow-Origin": originFor(request) || "https://whycommunism.com",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
}

function json(request, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(request) });
}

function previewUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch (_) { throw new Error("Invalid preview URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid preview URL.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1" || host.startsWith("127.")) throw new Error("That preview address is not allowed.");
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const numbers = ipv4.slice(1).map(Number);
    if (numbers.some((number) => number > 255) || numbers[0] === 10 || numbers[0] === 0 || numbers[0] === 127 || (numbers[0] === 169 && numbers[1] === 254) || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) || (numbers[0] === 192 && numbers[1] === 168)) throw new Error("That preview address is not allowed.");
  }
  if (host.includes(":") && /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)) throw new Error("That preview address is not allowed.");
  url.hash = "";
  return url;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([a-f0-9]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function pageMetadata(html) {
  const metadata = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const attr of match[0].matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[attr[1].toLowerCase()] = attr[3];
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !metadata.has(key)) metadata.set(key, decodeEntities(attrs.content));
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: metadata.get("og:title") || metadata.get("twitter:title") || decodeEntities(titleMatch?.[1] || ""),
    description: metadata.get("og:description") || metadata.get("twitter:description") || metadata.get("description") || "",
    image: metadata.get("og:image:secure_url") || metadata.get("og:image") || metadata.get("twitter:image") || "",
    site: metadata.get("og:site_name") || ""
  };
}

async function getLinkPreview(request, rawUrl) {
  if (!originFor(request)) return json(request, { error: "Link previews are available only to Why Communism." }, 403);
  const requested = previewUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  let response;
  try {
    response = await fetch(requested, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "WhyCommunismLinkPreview/1.0" }
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error("That website did not provide a preview.");
  const finalUrl = previewUrl(response.url || requested.toString());
  if (!String(response.headers.get("Content-Type") || "").toLowerCase().includes("text/html")) throw new Error("That link is not an HTML page.");
  const length = Number(response.headers.get("Content-Length") || 0);
  if (length > MAX_PREVIEW_HTML_BYTES) throw new Error("That page is too large to preview.");
  const html = (await response.text()).slice(0, MAX_PREVIEW_HTML_BYTES);
  const metadata = pageMetadata(html);
  let image = "";
  if (metadata.image) {
    try { image = previewUrl(new URL(metadata.image, finalUrl).toString()).toString(); }
    catch (_) {}
  }
  const headers = responseHeaders(request);
  headers["Cache-Control"] = "public, max-age=21600";
  return new Response(JSON.stringify({
    url: finalUrl.toString(),
    host: finalUrl.hostname.replace(/^www\./, ""),
    site: metadata.site.slice(0, 120),
    title: (metadata.title || finalUrl.hostname).slice(0, 240),
    description: metadata.description.slice(0, 420),
    image
  }), { headers });
}

function validPath(value) {
  return typeof value === "string" && value.length <= 240 && PATH_PATTERN.test(value);
}

function archiveFile(path) {
  return "article-archives/" + path.replace(/^\/+|\/+$/g, "").replace(/\//g, "--") + ".json";
}

function articleKey(path) {
  return path.replace(/^\/+|\/+$/g, "").replace(/\//g, "--");
}

function cleanFilename(value) {
  const cleaned = String(value || "file").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "file").slice(-140);
}

function attachmentType(filename, proposed) {
  const extension = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
  const types = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  const resolved = types[extension] || "";
  if (!resolved) throw new Error("That file type is not supported. Use an image, PDF, text, Markdown, CSV, Word, spreadsheet, or presentation file.");
  if (String(proposed || "").startsWith("image/") && !resolved.startsWith("image/")) throw new Error("The attachment type does not match its filename.");
  return resolved;
}

function utcTimestamp(value, fallback = true) {
  const date = new Date(String(value || ""));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return fallback ? new Date().toISOString() : "";
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) throw new Error("Invalid message collection.");
  return value.map((message, index) => {
    if (!message || typeof message !== "object") throw new Error("Invalid message at position " + (index + 1) + ".");
    const content = String(message.content || "");
    if (!content.trim() || content.length > 200_000) throw new Error("Invalid message content at position " + (index + 1) + ".");
    return {
      id: String(message.id || crypto.randomUUID()).slice(0, 120),
      sourceId: String(message.sourceId || "").slice(0, 240),
      author: String(message.author || "User").trim().slice(0, 100) || "User",
      timestamp: utcTimestamp(message.timestamp),
      content,
      replyTo: String(message.replyTo || "").slice(0, 120),
      replyAuthor: String(message.replyAuthor || "").slice(0, 100),
      replyExcerpt: String(message.replyExcerpt || "").slice(0, 280),
      editedAt: message.editedAt ? utcTimestamp(message.editedAt, false) : ""
    };
  });
}

async function parseBody(request, maximum = MAX_BODY_BYTES) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maximum) throw new Error("This request is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("This request is too large.");
  return JSON.parse(text);
}

function githubHeaders(env) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "User-Agent": "whycommunism-archive-editor",
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  };
}

function githubUrl(env, endpoint) {
  return "https://api.github.com/repos/" + encodeURIComponent(env.GITHUB_OWNER) + "/" + encodeURIComponent(env.GITHUB_REPO) + endpoint;
}

async function github(env, endpoint, options = {}) {
  const response = await fetch(githubUrl(env, endpoint), {
    ...options,
    headers: { ...githubHeaders(env), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "GitHub could not complete this request.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function decodeContent(value) {
  const binary = atob(String(value || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeContent(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function currentFile(env, path, ref = env.GITHUB_BRANCH) {
  const file = archiveFile(path);
  try {
    const payload = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref));
    return { file, sha: payload.sha, document: decodeContent(payload.content) };
  } catch (error) {
    if (error.status === 404) return { file, sha: "", document: null };
    throw error;
  }
}

function publicDocument(path, current) {
  const document = current.document || {};
  return {
    path,
    title: document.title || "",
    messages: Array.isArray(document.messages) ? document.messages : [],
    sha: current.sha || "",
    updatedAt: document.updatedAt || null
  };
}

async function getArchive(request, env, path) {
  return json(request, publicDocument(path, await currentFile(env, path)));
}

async function saveArchive(request, env, path, checkpointOnly = false) {
  if (!originFor(request)) return json(request, { error: "Writes are accepted only from Why Communism." }, 403);
  const body = await parseBody(request);
  const current = await currentFile(env, path);
  const baseSha = String(body.baseSha || "");
  if (current.sha !== baseSha) {
    return json(request, { error: "This article changed somewhere else.", conflict: true, sha: current.sha }, 409);
  }
  const messages = checkpointOnly
    ? normalizeMessages(current.document?.messages || [])
    : normalizeMessages(body.messages);
  const now = new Date().toISOString();
  const title = String(body.title || current.document?.title || "Untitled article").trim().slice(0, 240) || "Untitled article";
  const note = String(body.note || (checkpointOnly ? "Manual checkpoint" : "Update article archive")).trim().slice(0, 160);
  const document = {
    format: "whycommunism-article-archive-v1",
    path,
    title,
    messages,
    updatedAt: now,
    checkpointAt: checkpointOnly ? now : (current.document?.checkpointAt || null)
  };
  const commit = await github(env, "/contents/" + current.file.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "archive: " + note,
      content: encodeContent(document),
      branch: env.GITHUB_BRANCH,
      ...(current.sha ? { sha: current.sha } : {})
    })
  });
  return json(request, { ok: true, sha: commit.content?.sha || "", commit: commit.commit?.sha || "", updatedAt: now });
}

async function getHistory(request, env, path) {
  const file = archiveFile(path);
  const commits = await github(env,
    "/commits?sha=" + encodeURIComponent(env.GITHUB_BRANCH) + "&path=" + encodeURIComponent(file) + "&per_page=80"
  );
  return json(request, {
    path,
    versions: commits.map((item) => ({
      sha: item.sha,
      note: String(item.commit?.message || "Saved archive version").replace(/^archive:\s*/i, ""),
      savedAt: item.commit?.author?.date || item.commit?.committer?.date || null,
      githubAuthor: item.author?.login || item.commit?.author?.name || "Why Communism"
    }))
  });
}

async function getVersion(request, env, path, sha) {
  if (!/^[a-f0-9]{40}$/i.test(sha || "")) return json(request, { error: "Invalid Git revision." }, 400);
  const current = await currentFile(env, path, sha);
  if (!current.document) return json(request, { error: "That version was not found." }, 404);
  return json(request, { ...publicDocument(path, current), commit: sha });
}

async function uploadAttachment(request, env, path) {
  if (!originFor(request)) return json(request, { error: "Uploads are accepted only from Why Communism." }, 403);
  const body = await parseBody(request, MAX_ATTACHMENT_REQUEST_BYTES);
  const filename = cleanFilename(body.filename);
  const contentType = attachmentType(filename, body.contentType);
  const bytes = decodeBase64(body.base64);
  if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be between 1 byte and 8 MB.");
  const file = "attachments/" + articleKey(path) + "/" + crypto.randomUUID() + "-" + filename;
  const result = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "attachment: " + filename,
      content: String(body.base64).replace(/\s/g, ""),
      branch: env.GITHUB_BRANCH
    })
  });
  const url = new URL(request.url);
  url.pathname = "/v1/attachment";
  url.search = "?file=" + encodeURIComponent(file);
  return json(request, { ok: true, filename, contentType, bytes: bytes.byteLength, sha: result.content?.sha || "", url: url.toString() });
}

async function getAttachment(request, env, file) {
  if (!/^attachments\/[a-z0-9-]+\/[a-f0-9-]{36}-[a-zA-Z0-9._-]+$/.test(file || "")) return json(request, { error: "Invalid attachment path." }, 400);
  const metadata = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(env.GITHUB_BRANCH));
  const blob = await github(env, "/git/blobs/" + encodeURIComponent(metadata.sha));
  const bytes = decodeBase64(blob.content);
  const filename = file.split("/").pop().replace(/^[a-f0-9-]{37}/, "");
  const contentType = attachmentType(filename, "");
  const inline = contentType.startsWith("image/") || contentType.startsWith("application/pdf");
  return new Response(bytes, {
    headers: {
      "Access-Control-Allow-Origin": originFor(request) || "https://whycommunism.com",
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": (inline ? "inline" : "attachment") + '; filename="' + filename.replace(/["\\]/g, "-") + '"',
      "Content-Length": String(bytes.byteLength),
      "Content-Type": contentType,
      "Vary": "Origin"
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request) });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json(request, { ok: true, service: "whycommunism-github-archive" });
    if (url.pathname === "/v1/link-preview" && request.method === "GET") {
      try { return await getLinkPreview(request, url.searchParams.get("url") || ""); }
      catch (error) { return json(request, { error: error.name === "AbortError" ? "That website took too long to preview." : (error.message || "That website could not be previewed.") }, 422); }
    }
    if (!env.GITHUB_TOKEN) return json(request, { error: "The GitHub archive credential is not configured." }, 503);
    if (url.pathname === "/v1/attachment" && request.method === "GET") {
      try { return await getAttachment(request, env, url.searchParams.get("file") || ""); }
      catch (error) { return json(request, { error: error.message || "The attachment could not be loaded." }, error.status === 404 ? 404 : 500); }
    }
    const path = url.searchParams.get("path") || "";
    if (!validPath(path)) return json(request, { error: "Invalid article path." }, 400);
    try {
      if (url.pathname === "/v1/archive" && request.method === "GET") return await getArchive(request, env, path);
      if (url.pathname === "/v1/archive" && request.method === "PUT") return await saveArchive(request, env, path, false);
      if (url.pathname === "/v1/checkpoint" && request.method === "POST") return await saveArchive(request, env, path, true);
      if (url.pathname === "/v1/history" && request.method === "GET") return await getHistory(request, env, path);
      if (url.pathname === "/v1/version" && request.method === "GET") return await getVersion(request, env, path, url.searchParams.get("sha"));
      if (url.pathname === "/v1/attachment" && request.method === "POST") return await uploadAttachment(request, env, path);
      return json(request, { error: "Not found." }, 404);
    } catch (error) {
      const status = error.status === 404 ? 404 : error.status === 409 ? 409 : error.status === 403 ? 403 : 500;
      return json(request, { error: error.message || "The GitHub archive could not complete this request." }, status);
    }
  }
};
