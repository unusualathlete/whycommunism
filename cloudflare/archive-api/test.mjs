import worker from "./src/index.js";

const originalFetch = globalThis.fetch;
const files = new Map();
const blobs = new Map();
const commits = [];
let sequence = 0;

function apiResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

globalThis.fetch = async function (input, options = {}) {
  const url = new URL(input);
  const method = options.method || "GET";
  if (url.hostname === "example.com") {
    return new Response('<html><head><meta property="og:site_name" content="Example"><meta property="og:title" content="A useful page"><meta property="og:description" content="A clear description."><meta property="og:image" content="/card.jpg"></head></html>', {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "231" }
    });
  }
  const contentMatch = url.pathname.match(/\/contents\/(.+)$/);
  if (contentMatch && method === "GET") {
    const file = decodeURIComponent(contentMatch[1]);
    const entry = files.get(file);
    if (!entry) return apiResponse({ message: "Not Found" }, 404);
    return apiResponse({ sha: entry.sha, content: entry.content });
  }
  if (contentMatch && method === "PUT") {
    const file = decodeURIComponent(contentMatch[1]);
    const body = JSON.parse(options.body);
    const current = files.get(file);
    if ((current?.sha || "") !== (body.sha || "")) return apiResponse({ message: "Conflict" }, 409);
    const sha = (++sequence).toString(16).padStart(40, "0");
    const commit = (sequence + 1000).toString(16).padStart(40, "0");
    files.set(file, { sha, content: body.content });
    blobs.set(sha, body.content);
    commits.unshift({
      sha: commit,
      commit: { message: body.message, author: { date: new Date().toISOString(), name: "Test" } },
      author: { login: "test-user" }
    });
    return apiResponse({ content: { sha }, commit: { sha: commit } });
  }
  const blobMatch = url.pathname.match(/\/git\/blobs\/([a-f0-9]{40})$/);
  if (blobMatch && method === "GET") return blobs.has(blobMatch[1]) ? apiResponse({ sha: blobMatch[1], encoding: "base64", content: blobs.get(blobMatch[1]) }) : apiResponse({ message: "Not Found" }, 404);
  if (url.pathname.endsWith("/commits") && method === "GET") return apiResponse(commits);
  return apiResponse({ message: "Unexpected GitHub request" }, 500);
};

const env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "unusualathlete",
  GITHUB_REPO: "whycommunism-archives",
  GITHUB_BRANCH: "main"
};
const origin = "https://whycommunism.com";
const path = "/guides/how-society-changes/overview/";
const endpoint = "https://archive.whycommunism.com/v1/archive?path=" + encodeURIComponent(path);

function request(url, options = {}) {
  return new Request(url, {
    ...options,
    headers: { Origin: origin, "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

try {
  let response = await worker.fetch(request("https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("https://example.com/article")), env);
  let payload = await response.json();
  assert(response.status === 200 && payload.title === "A useful page" && payload.image === "https://example.com/card.jpg", "Website preview metadata was not created.");

  response = await worker.fetch(request(endpoint), env);
  payload = await response.json();
  assert(response.status === 200 && payload.sha === "" && payload.messages.length === 0, "Empty archive did not load.");

  response = await worker.fetch(request(endpoint, {
    method: "PUT",
    body: JSON.stringify({
      title: "Materialism",
      baseSha: "",
      note: "First message",
      messages: [
        { id: "one", author: "User", timestamp: "2026-07-22T08:00:00+08:00", content: "**Hello**" },
        { id: "two", author: "Reader", timestamp: "2026-07-22T00:01:00Z", content: "A reply", replyTo: "one", replyAuthor: "User", replyExcerpt: "Hello" }
      ]
    })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && /^[a-f0-9]{40}$/.test(payload.sha), "Archive was not created.");
  const firstSha = payload.sha;

  response = await worker.fetch(request(endpoint), env);
  payload = await response.json();
  assert(payload.messages[1].replyTo === "one" && payload.messages[1].replyAuthor === "User", "Reply relationships were not preserved.");
  assert(payload.messages[0].timestamp === "2026-07-22T00:00:00.000Z", "Timezone offsets were not normalized to UTC.");

  response = await worker.fetch(request(endpoint, {
    method: "PUT",
    body: JSON.stringify({ title: "Materialism", baseSha: "", messages: [{ content: "Conflict" }] })
  }), env);
  payload = await response.json();
  assert(response.status === 409 && payload.conflict && payload.sha === firstSha, "Concurrent edit was not rejected.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/checkpoint?path=" + encodeURIComponent(path), {
    method: "POST",
    body: JSON.stringify({ title: "Materialism", baseSha: firstSha, note: "Manual checkpoint" })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.sha !== firstSha, "Checkpoint did not create a version.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/history?path=" + encodeURIComponent(path)), env);
  payload = await response.json();
  assert(response.status === 200 && payload.versions.length === 2, "History did not return both versions.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/attachment?path=" + encodeURIComponent(path), {
    method: "POST",
    body: JSON.stringify({ filename: "diagram.png", contentType: "image/png", base64: btoa("test-image") })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.filename === "diagram.png" && payload.url.includes("%2F"), "Attachment was not uploaded.");

  response = await worker.fetch(request(payload.url), env);
  assert(response.status === 200 && response.headers.get("Content-Type") === "image/png" && await response.text() === "test-image", "Attachment could not be downloaded.");

  console.log("archive-api tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
