(function () {
  "use strict";

  var article = document.querySelector("main.art");
  var hero = document.querySelector("header.hero");
  if (!article || !hero) return;

  var articlePath = location.pathname.replace(/\/+$/, "") + "/";
  var articleTitle = (hero.querySelector("h1") || document.querySelector("title")).textContent.trim();
  var dbPromise;
  var loaded = false;
  var messages = [];
  var displayLimit = 150;
  var remoteSha = "";
  var online = false;
  var replyingTo = null;
  var API_ORIGIN = "https://archive.whycommunism.com";

  var modebar = document.createElement("section");
  modebar.className = "wce-modebar";
  modebar.setAttribute("aria-label", "Article workspace mode");
  modebar.innerHTML =
    '<span class="wce-mode-label">Article workspace</span>' +
    '<div class="wce-mode-tabs" role="group" aria-label="Choose archive or current draft">' +
      '<button class="wce-mode is-active" type="button" data-wce-mode="edit" aria-pressed="true">Archive editor</button>' +
      '<button class="wce-mode" type="button" data-wce-mode="read" aria-pressed="false">Read current draft</button>' +
    "</div>";

  var workspace = document.createElement("section");
  workspace.className = "wce-editor wce-message-editor";
  workspace.innerHTML =
    '<header class="wce-editor-head">' +
      '<div><span class="wce-eyebrow">Discord archive workspace</span><h2></h2></div>' +
      '<span class="wce-save-state" role="status" aria-live="polite">Opening local archive…</span>' +
    "</header>" +
    '<p class="wce-explainer">Store the human source material for this topic as editable messages. Add passages, notes, images, videos, YouTube links, and ordinary links with the composer below. Discord-style Markdown renders in place.</p>' +
    '<div class="wce-archive-tools">' +
      '<button type="button" data-wce-action="checkpoint">Save checkpoint</button>' +
      '<button type="button" data-wce-action="history" aria-expanded="false">Version history</button>' +
    "</div>" +
    '<section class="wce-stream" aria-label="Archived messages">' +
      '<header class="wce-stream-head"><div><span class="wce-eyebrow">Source messages</span><h3>Archive for this topic</h3></div><span class="wce-message-count">0 messages</span></header>' +
      '<div class="wce-empty"><strong>No source messages yet.</strong><span>Write the first note below.</span></div>' +
      '<button class="wce-load-more" type="button" data-wce-action="more" hidden>Load older messages</button>' +
      '<div class="wce-message-list"></div>' +
      '<form class="wce-composer">' +
        '<div class="wce-composer-head"><label>Author or source<input class="wce-author" type="text" value="User" placeholder="User" maxlength="100"></label><span>Enter sends · Shift + Enter adds a line</span></div>' +
        '<div class="wce-replying" hidden><span>Replying to <strong></strong><i></i></span><button type="button" data-wce-action="reply-cancel" aria-label="Cancel reply">×</button></div>' +
        '<textarea class="wce-composer-text" rows="4" spellcheck="true" placeholder="Write a note, paste a message, or add an image or link…"></textarea>' +
        '<input class="wce-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.doc,.docx,.odt,.xls,.xlsx,.ppt,.pptx" multiple hidden>' +
        '<div class="wce-composer-preview" hidden></div>' +
        '<div class="wce-composer-foot"><span class="wce-compose-count">0 words</span><button class="wce-attach" type="button" data-wce-action="attach" aria-label="Add images or documents">+ Add files</button><button type="button" data-wce-action="composer-preview" aria-expanded="false">Preview</button><button class="wce-primary" type="submit">Add to archive</button></div>' +
      "</form>" +
    "</section>" +
    '<section class="wce-history" hidden><div class="wce-history-head"><div><span class="wce-eyebrow">Version history</span><h3>Workspace checkpoints</h3></div><button type="button" data-wce-action="history-close">Close</button></div><div class="wce-history-list"></div></section>' +
    '<p class="wce-storage-note"><strong>Saved online:</strong> this shared archive and its revision history are available across devices. A local copy is also retained in this browser for recovery, and backups can be exported at any time.</p>';

  workspace.querySelector(".wce-editor-head h2").textContent = articleTitle;
  hero.insertAdjacentElement("afterend", modebar);
  modebar.insertAdjacentElement("afterend", workspace);

  var readButton = modebar.querySelector('[data-wce-mode="read"]');
  var editButton = modebar.querySelector('[data-wce-mode="edit"]');
  var status = workspace.querySelector(".wce-save-state");
  var emptyState = workspace.querySelector(".wce-empty");
  var messageList = workspace.querySelector(".wce-message-list");
  var messageCount = workspace.querySelector(".wce-message-count");
  var loadMoreButton = workspace.querySelector(".wce-load-more");
  var composer = workspace.querySelector(".wce-composer");
  var composerAuthor = workspace.querySelector(".wce-author");
  var composerText = workspace.querySelector(".wce-composer-text");
  var replyingBar = workspace.querySelector(".wce-replying");
  var fileInput = workspace.querySelector(".wce-file-input");
  var composerPreview = workspace.querySelector(".wce-composer-preview");
  var composerPreviewButton = workspace.querySelector('[data-wce-action="composer-preview"]');
  var composeCount = workspace.querySelector(".wce-compose-count");
  var historyButton = workspace.querySelector('[data-wce-action="history"]');
  var historyPanel = workspace.querySelector(".wce-history");
  var historyList = workspace.querySelector(".wce-history-list");

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "wce-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function setMode(mode, shouldFocus) {
    var editing = mode === "edit";
    readButton.classList.toggle("is-active", !editing);
    editButton.classList.toggle("is-active", editing);
    readButton.setAttribute("aria-pressed", editing ? "false" : "true");
    editButton.setAttribute("aria-pressed", editing ? "true" : "false");
    article.hidden = editing;
    workspace.hidden = !editing;
    if (editing) ensureLoaded().then(function () { if (shouldFocus) composerText.focus(); });
  }

  function openDatabase() {
    if (!window.indexedDB) return Promise.reject(new Error("Browser storage is unavailable."));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open("whycommunism-archive-editor", 2);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents", { keyPath: "path" });
        var versions;
        if (!db.objectStoreNames.contains("versions")) {
          versions = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
        } else {
          versions = request.transaction.objectStore("versions");
        }
        if (!versions.indexNames.contains("path")) versions.createIndex("path", "path", { unique: false });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Could not open browser storage.")); };
    });
    return dbPromise;
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Browser storage failed.")); };
    });
  }

  function transactionDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error("Browser storage failed.")); };
      tx.onabort = function () { reject(tx.error || new Error("Browser storage was interrupted.")); };
    });
  }

  async function getDocument(db) {
    return requestResult(db.transaction("documents", "readonly").objectStore("documents").get(articlePath));
  }

  async function putDocument(db) {
    var tx = db.transaction("documents", "readwrite");
    tx.objectStore("documents").put({ path: articlePath, title: articleTitle, messages: messages, sha: remoteSha, updatedAt: Date.now() });
    await transactionDone(tx);
  }

  async function addSnapshot(db, note, snapshotMessages) {
    var tx = db.transaction("versions", "readwrite");
    tx.objectStore("versions").add({
      path: articlePath,
      title: articleTitle,
      note: note || "Saved checkpoint",
      savedAt: Date.now(),
      messages: snapshotMessages || messages
    });
    await transactionDone(tx);
    await pruneHistory(db);
  }

  async function getLocalVersions(db) {
    var tx = db.transaction("versions", "readonly");
    var index = tx.objectStore("versions").index("path");
    var versions = await requestResult(index.getAll(IDBKeyRange.only(articlePath)));
    return versions.sort(function (a, b) { return b.savedAt - a.savedAt; });
  }

  async function pruneHistory(db) {
    var versions = await getLocalVersions(db);
    if (versions.length <= 80) return;
    var tx = db.transaction("versions", "readwrite");
    versions.slice(80).forEach(function (version) { tx.objectStore("versions").delete(version.id); });
    await transactionDone(tx);
  }

  function legacyMessages(record) {
    if (!record) return [];
    if (Array.isArray(record.messages)) return record.messages;
    if (record.text) {
      return [{ id: uid(), author: "Imported archive draft", timestamp: new Date(record.updatedAt || Date.now()).toISOString(), content: record.text, sourceId: "legacy-text" }];
    }
    return [];
  }

  async function apiRequest(path, options) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    var response;
    try {
      response = await fetch(API_ORIGIN + path, Object.assign({
        headers: { "Content-Type": "application/json" },
        signal: controller.signal
      }, options || {}));
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(error.name === "AbortError" ? "The online archive took too long to respond." : "The online archive is temporarily unavailable.");
    }
    clearTimeout(timeout);
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var failure = new Error(payload.error || "The online archive could not complete this request.");
      failure.status = response.status;
      failure.conflict = Boolean(payload.conflict);
      failure.sha = String(payload.sha || "");
      throw failure;
    }
    return payload;
  }

  function archiveQuery(endpoint) {
    return endpoint + "?path=" + encodeURIComponent(articlePath);
  }

  async function fetchRemoteArchive() {
    return apiRequest(archiveQuery("/v1/archive"));
  }

  async function fetchRemoteHistory() {
    var payload = await apiRequest(archiveQuery("/v1/history"));
    return Array.isArray(payload.versions) ? payload.versions : [];
  }

  async function fetchRemoteVersion(sha) {
    return apiRequest(archiveQuery("/v1/version") + "&sha=" + encodeURIComponent(sha));
  }

  async function saveRemote(note) {
    var payload = await apiRequest(archiveQuery("/v1/archive"), {
      method: "PUT",
      body: JSON.stringify({ title: articleTitle, messages: messages, note: note, baseSha: remoteSha })
    });
    remoteSha = String(payload.sha || remoteSha);
    online = true;
    return payload;
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = function () { reject(reader.error || new Error("Could not read " + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  async function uploadAttachment(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error(file.name + " is larger than the 8 MB attachment limit.");
    var payload = await apiRequest(archiveQuery("/v1/attachment"), {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream", base64: await fileToBase64(file) })
    });
    return payload;
  }

  function insertComposerText(text) {
    var start = composerText.selectionStart;
    var end = composerText.selectionEnd;
    var before = composerText.value.slice(0, start);
    var after = composerText.value.slice(end);
    var prefix = before && !before.endsWith("\n") ? "\n" : "";
    var suffix = after && !after.startsWith("\n") ? "\n" : "";
    composerText.value = before + prefix + text + suffix + after;
    var cursor = (before + prefix + text + suffix).length;
    composerText.setSelectionRange(cursor, cursor);
    composerText.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function addAttachments(files) {
    var selected = Array.from(files || []).slice(0, 4);
    if (!selected.length) return;
    setStatus("Uploading " + selected.length.toLocaleString() + (selected.length === 1 ? " file…" : " files…"), "saving");
    fileInput.disabled = true;
    try {
      for (var index = 0; index < selected.length; index += 1) {
        var file = selected[index];
        var uploaded = await uploadAttachment(file);
        var label = String(uploaded.filename || file.name).replace(/[\[\]]/g, "");
        insertComposerText((uploaded.contentType || file.type).startsWith("image/") ? "![" + label + "](" + uploaded.url + ")" : "[📎 " + label + "](" + uploaded.url + ")");
      }
      setStatus("Files attached · add the message to save their links", "saved");
    } catch (error) {
      setStatus(error.message || "Could not upload the selected file", "error");
    } finally {
      fileInput.disabled = false;
      fileInput.value = "";
      composerText.focus();
    }
  }

  function revisionLabel() {
    return remoteSha ? remoteSha.slice(0, 7) : "new";
  }

  function setStatus(message, kind) {
    status.textContent = message;
    status.dataset.state = kind || "saved";
  }

  function wordCount(text) {
    var clean = String(text || "").trim();
    return clean ? clean.split(/\s+/).length : 0;
  }

  function timeLabel(value) {
    var date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return String(value || "Unknown time");
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function safeUrl(value) {
    try {
      var url = new URL(value, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function inlineMarkdown(source) {
    var tokens = [];
    function token(html) {
      var marker = "\u0000WCE" + tokens.length + "\u0000";
      tokens.push(html);
      return marker;
    }
    var text = String(source || "");
    text = text.replace(/`([^`\n]+)`/g, function (_, code) { return token("<code>" + escapeHtml(code) + "</code>"); });
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, function (whole, alt, url) {
      var safe = safeUrl(url);
      return safe ? token('<a class="wce-image-attachment" href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer" aria-label="Open image"><img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt) + '" loading="lazy"></a>') : whole;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (whole, label, url) {
      var safe = safeUrl(url);
      return safe ? token('<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + "</a>") : whole;
    });
    text = escapeHtml(text);
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(/\|\|([^|\n]+)\|\|/g, '<span class="wce-spoiler" tabindex="0">$1</span>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    text = text.replace(/https?:\/\/[^\s<\u0000]+/g, function (raw) {
      var trailing = raw.match(/[.,!?;:]+$/);
      var clean = trailing ? raw.slice(0, -trailing[0].length) : raw;
      var safe = safeUrl(clean.replace(/&amp;/g, "&"));
      return safe ? '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + clean + "</a>" + (trailing ? trailing[0] : "") : raw;
    });
    return text.replace(/\u0000WCE(\d+)\u0000/g, function (_, index) { return tokens[Number(index)]; });
  }

  function youtubeId(value) {
    try {
      var url = new URL(value);
      var host = url.hostname.replace(/^www\./, "");
      var id = "";
      if (host === "youtu.be") id = url.pathname.split("/")[1] || "";
      if (host === "youtube.com" || host === "m.youtube.com") {
        id = url.searchParams.get("v") || "";
        if (!id && /^\/(shorts|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2] || "";
      }
      return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  }

  function standaloneEmbed(value) {
    var safe = safeUrl(value.trim());
    if (!safe) return null;
    var youtube = youtubeId(safe);
    if (youtube) return '<figure class="wce-embed wce-video"><iframe src="https://www.youtube-nocookie.com/embed/' + escapeHtml(youtube) + '" title="Embedded YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><figcaption><a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">Open on YouTube</a></figcaption></figure>';
    if (/\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(safe)) return '<figure class="wce-embed wce-image"><img src="' + escapeHtml(safe) + '" alt="Embedded archive image" loading="lazy"><figcaption><a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">Open original image</a></figcaption></figure>';
    if (/\.(?:mp4|webm|ogg)(?:[?#].*)?$/i.test(safe)) return '<figure class="wce-embed"><video src="' + escapeHtml(safe) + '" controls preload="metadata"></video><figcaption><a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">Open video</a></figcaption></figure>';
    var host = new URL(safe).hostname.replace(/^www\./, "");
    return '<a class="wce-link-card" data-wce-preview-url="' + escapeHtml(safe) + '" href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer"><span>' + escapeHtml(host) + '</span><strong>' + escapeHtml(safe) + '</strong><i>Open link ↗</i></a>';
  }

  async function hydrateLinkPreviews(root) {
    var cards = Array.from(root.querySelectorAll(".wce-link-card[data-wce-preview-url]:not([data-wce-preview-loaded])"));
    cards.forEach(async function (card) {
      card.dataset.wcePreviewLoaded = "loading";
      try {
        var payload = await apiRequest("/v1/link-preview?url=" + encodeURIComponent(card.dataset.wcePreviewUrl));
        var copy = document.createElement("span");
        copy.className = "wce-link-preview-copy";
        var host = document.createElement("span");
        host.textContent = payload.site || payload.host || "Website";
        var title = document.createElement("strong");
        title.textContent = payload.title || payload.url;
        copy.append(host, title);
        if (payload.description) {
          var description = document.createElement("em");
          description.textContent = payload.description;
          copy.appendChild(description);
        }
        var open = document.createElement("i");
        open.textContent = "Open link ↗";
        copy.appendChild(open);
        card.replaceChildren();
        card.appendChild(copy);
        var imageUrl = payload.image ? safeUrl(payload.image) : null;
        if (imageUrl) {
          var image = document.createElement("img");
          image.className = "wce-link-preview-image";
          image.src = imageUrl;
          image.alt = "";
          image.loading = "lazy";
          card.appendChild(image);
        }
        card.classList.add("has-preview");
        card.dataset.wcePreviewLoaded = "ready";
      } catch (_) {
        card.dataset.wcePreviewLoaded = "unavailable";
      }
    });
  }

  function renderMarkdown(source) {
    if (!String(source || "").trim()) return "";
    var previewMatch = String(source).match(/https?:\/\/[^\s)]+/i);
    var previewCandidate = previewMatch ? previewMatch[0].replace(/[.,!?;:]+$/, "") : "";
    var lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    var output = [];
    var inCode = false;
    var language = "";
    var codeLines = [];
    var listType = null;
    var renderedStandalone = false;
    function closeList() { if (listType) output.push("</" + listType + ">"); listType = null; }
    lines.forEach(function (line) {
      var fence = line.match(/^```\s*([^\s`]*)\s*$/);
      if (fence) {
        if (inCode) {
          output.push('<pre><code' + (language ? ' data-language="' + escapeHtml(language) + '"' : "") + ">" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
          inCode = false; language = ""; codeLines = [];
        } else { closeList(); inCode = true; language = fence[1] || ""; }
        return;
      }
      if (inCode) { codeLines.push(line); return; }
      if (!line.trim()) { closeList(); return; }
      var heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { closeList(); var level = Math.min(heading[1].length + 1, 6); output.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">"); return; }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { closeList(); output.push("<hr>"); return; }
      var quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) { closeList(); output.push("<blockquote><p>" + inlineMarkdown(quote[1]) + "</p></blockquote>"); return; }
      var unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      var ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        var wanted = unordered ? "ul" : "ol";
        if (listType !== wanted) { closeList(); listType = wanted; output.push("<" + wanted + ">"); }
        output.push("<li>" + inlineMarkdown((unordered || ordered)[1]) + "</li>"); return;
      }
      closeList();
      var embed = /^\s*https?:\/\/\S+\s*$/.test(line) ? standaloneEmbed(line) : null;
      if (embed) renderedStandalone = true;
      output.push(embed || "<p>" + inlineMarkdown(line) + "</p>");
    });
    if (inCode) output.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
    closeList();
    if (!renderedStandalone && previewCandidate && !/\.(?:png|jpe?g|gif|webp|avif|mp4|webm|ogg)(?:[?#].*)?$/i.test(previewCandidate) && !previewCandidate.includes("/v1/attachment?")) {
      var preview = standaloneEmbed(previewCandidate);
      if (preview) output.push(preview);
    }
    return output.join("");
  }

  function renderComposerPreview() {
    composerPreview.innerHTML = renderMarkdown(composerText.value) || '<p class="wce-preview-empty">Nothing to preview yet.</p>';
    hydrateLinkPreviews(composerPreview);
  }

  function messageWords() {
    return messages.reduce(function (total, message) { return total + wordCount(message.content); }, 0);
  }

  function initials(name) {
    return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join("") || "?";
  }

  function compactExcerpt(content, maximum) {
    var plain = String(content || "")
      .replace(/```[\s\S]*?```/g, " code ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1 image")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~|`>#-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length <= maximum) return plain;
    return plain.slice(0, Math.max(0, maximum - 1)).trimEnd() + "…";
  }

  function messageById(id) {
    return messages.find(function (item) { return item.id === id; }) || null;
  }

  function setReplyTarget(message) {
    replyingTo = {
      id: message.id,
      author: message.author || "User",
      excerpt: compactExcerpt(message.content, 180) || "Message"
    };
    replyingBar.hidden = false;
    replyingBar.querySelector("strong").textContent = replyingTo.author;
    replyingBar.querySelector("i").textContent = replyingTo.excerpt;
    composerText.placeholder = "Reply to " + replyingTo.author + "…";
    composerText.focus();
    composer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearReplyTarget() {
    replyingTo = null;
    replyingBar.hidden = true;
    replyingBar.querySelector("strong").textContent = "";
    replyingBar.querySelector("i").textContent = "";
    composerText.placeholder = "Write a note, paste a message, or add an image or link…";
  }

  function jumpToMessage(id) {
    var target = messageList.querySelector('[data-message-id="' + CSS.escape(id) + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-jump-target");
    requestAnimationFrame(function () { target.classList.add("is-jump-target"); });
    setTimeout(function () { target.classList.remove("is-jump-target"); }, 1800);
  }

  function createMessageCard(message, index) {
    var card = document.createElement("article");
    card.className = "wce-message";
    card.dataset.messageId = message.id;
    card.id = "message-" + message.id;
    var avatar = document.createElement("div");
    avatar.className = "wce-avatar";
    avatar.textContent = initials(message.author);
    var main = document.createElement("div");
    main.className = "wce-message-main";
    var replyContext = null;
    if (message.replyTo || message.replyExcerpt) {
      var parent = messageById(message.replyTo);
      replyContext = document.createElement("button");
      replyContext.type = "button";
      replyContext.className = "wce-reply-context";
      replyContext.innerHTML = '<span aria-hidden="true">↳</span><strong></strong><i></i>';
      replyContext.querySelector("strong").textContent = parent?.author || message.replyAuthor || "Earlier message";
      replyContext.querySelector("i").textContent = compactExcerpt(parent?.content || message.replyExcerpt, 180) || "Original message unavailable";
      replyContext.disabled = !parent;
      if (parent) replyContext.addEventListener("click", function () { jumpToMessage(parent.id); });
    }
    var head = document.createElement("header");
    var by = document.createElement("strong");
    by.textContent = message.author || "User";
    var when = document.createElement("time");
    when.textContent = message.timestamp ? timeLabel(message.timestamp) : "No timestamp";
    if (message.editedAt) when.textContent += " · edited";
    var actions = document.createElement("div");
    actions.className = "wce-message-actions";
    var reply = document.createElement("button");
    reply.type = "button"; reply.textContent = "Reply";
    var copyLink = document.createElement("button");
    copyLink.type = "button"; copyLink.textContent = "Link";
    var edit = document.createElement("button");
    edit.type = "button"; edit.textContent = "Edit";
    var remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "Delete";
    actions.append(reply, copyLink, edit, remove);
    head.append(by, when, actions);
    var body = document.createElement("div");
    body.className = "wce-message-body";
    body.innerHTML = renderMarkdown(message.content);
    hydrateLinkPreviews(body);
    var editBox = document.createElement("section");
    editBox.className = "wce-message-edit";
    editBox.hidden = true;
    editBox.innerHTML = '<div><label>Author<input type="text" data-field="author"></label><label>Timestamp<input type="text" data-field="timestamp"></label></div><label>Message<textarea data-field="content" rows="7" spellcheck="true"></textarea></label><footer><button type="button" data-edit="cancel">Cancel</button><button class="wce-primary" type="button" data-edit="save">Save message</button></footer>';
    var editAuthor = editBox.querySelector('[data-field="author"]');
    var editTime = editBox.querySelector('[data-field="timestamp"]');
    var editContent = editBox.querySelector('[data-field="content"]');
    edit.addEventListener("click", function () {
      editAuthor.value = message.author || "";
      editTime.value = message.timestamp || "";
      editContent.value = message.content || "";
      body.hidden = true; editBox.hidden = false; editContent.focus();
    });
    editBox.querySelector('[data-edit="cancel"]').addEventListener("click", function () { editBox.hidden = true; body.hidden = false; });
    editBox.querySelector('[data-edit="save"]').addEventListener("click", async function () {
      var before = messages.map(function (item) { return Object.assign({}, item); });
      message.author = editAuthor.value.trim() || "User";
      message.timestamp = editTime.value.trim();
      message.content = editContent.value;
      message.editedAt = new Date().toISOString();
      await persistChange("Before editing message from " + (before[index].author || "unknown author"), before);
    });
    reply.addEventListener("click", function () { setReplyTarget(message); });
    copyLink.addEventListener("click", async function () {
      var link = location.origin + location.pathname + location.search + "#message-" + encodeURIComponent(message.id);
      try {
        await navigator.clipboard.writeText(link);
        copyLink.textContent = "Copied";
        setTimeout(function () { copyLink.textContent = "Link"; }, 1600);
      } catch (_) {
        location.hash = "message-" + message.id;
      }
    });
    remove.addEventListener("click", function () {
      if (remove.dataset.confirm !== "yes") {
        remove.dataset.confirm = "yes"; remove.textContent = "Confirm delete";
        setTimeout(function () { remove.dataset.confirm = ""; remove.textContent = "Delete"; }, 3500);
        return;
      }
      var before = messages.map(function (item) { return Object.assign({}, item); });
      messages.splice(index, 1);
      persistChange("Before deleting message from " + (message.author || "unknown author"), before);
    });
    if (replyContext) main.append(replyContext);
    main.append(head, body, editBox);
    card.append(avatar, main);
    return card;
  }

  function renderMessages(options) {
    options = options || {};
    var previousHeight = document.documentElement.scrollHeight;
    var previousScroll = window.scrollY;
    messageList.replaceChildren();
    var firstIndex = Math.max(0, messages.length - displayLimit);
    var shown = messages.slice(firstIndex);
    shown.forEach(function (message, index) { messageList.appendChild(createMessageCard(message, firstIndex + index)); });
    emptyState.hidden = messages.length > 0;
    var remaining = Math.max(0, messages.length - displayLimit);
    loadMoreButton.hidden = remaining === 0;
    if (remaining) loadMoreButton.textContent = "Load older messages · " + Math.min(150, remaining).toLocaleString() + " of " + remaining.toLocaleString() + " remaining";
    messageCount.textContent = messages.length.toLocaleString() + " messages · " + messageWords().toLocaleString() + " words";
    if (options.preserveViewport) {
      var addedHeight = document.documentElement.scrollHeight - previousHeight;
      window.scrollTo(0, previousScroll + addedHeight);
    } else if (options.pinBottom) {
      requestAnimationFrame(function () { composer.scrollIntoView({ behavior: options.instant ? "auto" : "smooth", block: "end" }); });
    } else if (location.hash.indexOf("#message-") === 0) {
      var targetId = decodeURIComponent(location.hash.slice(9));
      setTimeout(function () { jumpToMessage(targetId); }, 0);
    }
  }

  async function ensureLoaded() {
    if (loaded) return;
    var db = null;
    var record = null;
    try {
      db = await openDatabase();
      record = await getDocument(db);
    } catch (_) {}
    try {
      var remote = await fetchRemoteArchive();
      remoteSha = String(remote.sha || "");
      online = true;
      var localMessages = legacyMessages(record);
      if (!remoteSha && localMessages.length) {
        messages = localMessages;
        await saveRemote("Migrated browser archive online");
      } else {
        messages = Array.isArray(remote.messages) ? remote.messages : [];
      }
      if (db) await putDocument(db);
      setStatus("Online archive ready · version " + revisionLabel(), "saved");
    } catch (error) {
      messages = legacyMessages(record);
      remoteSha = String(record && record.sha || "");
      online = false;
      setStatus(messages.length ? "Cloud unavailable · restored local recovery copy" : (error.message || "The online archive is unavailable"), messages.length ? "saved" : "error");
    }
    loaded = true;
    renderMessages();
  }

  async function persistChange(note, before, options) {
    options = options || {};
    setStatus("Saving online…", "saving");
    var db = null;
    try {
      db = await openDatabase();
      await addSnapshot(db, note, before || messages);
    } catch (_) {}
    try {
      await saveRemote(note);
      if (db) await putDocument(db);
      if (!options.skipRender) renderMessages({ preserveViewport: true });
      setStatus("Saved online · version " + revisionLabel() + " · " + timeLabel(Date.now()), "saved");
      if (!historyPanel.hidden) await renderHistory();
    } catch (error) {
      online = false;
      if (db) await putDocument(db).catch(function () {});
      if (!options.skipRender) renderMessages({ preserveViewport: true });
      setStatus(error.conflict ? "Not saved · this article changed elsewhere. Reload before editing again." : "Saved only to this browser · " + (error.message || "cloud unavailable"), "error");
    }
  }

  async function saveCheckpoint() {
    setStatus("Saving online checkpoint…", "saving");
    var db = null;
    try {
      db = await openDatabase();
      await addSnapshot(db, "Manual checkpoint", messages);
    } catch (_) {}
    try {
      if (!remoteSha) await saveRemote("Initial online archive");
      var checkpoint = await apiRequest(archiveQuery("/v1/checkpoint"), {
        method: "POST",
        body: JSON.stringify({ note: "Manual checkpoint", title: articleTitle, baseSha: remoteSha })
      });
      remoteSha = String(checkpoint.sha || remoteSha);
      online = true;
      if (db) await putDocument(db);
      setStatus("Online checkpoint saved · " + timeLabel(Date.now()), "saved");
      if (!historyPanel.hidden) await renderHistory();
    } catch (error) {
      setStatus(error.conflict ? "Checkpoint not saved · reload because this article changed elsewhere." : (error.message || "Could not save the checkpoint"), "error");
    }
  }

  async function restoreVersion(version) {
    try {
      var before = messages.map(function (item) { return Object.assign({}, item); });
      var restored = version;
      if (!Array.isArray(restored.messages) && restored.sha) restored = await fetchRemoteVersion(restored.sha);
      messages = Array.isArray(restored.messages) ? restored.messages : legacyMessages(restored);
      displayLimit = 150;
      await persistChange("Restored version from " + timeLabel(version.savedAt || restored.updatedAt), before);
      await renderHistory();
    } catch (error) {
      setStatus(error.message || "Could not restore this checkpoint", "error");
    }
  }

  async function renderHistory() {
    historyList.replaceChildren();
    try {
      var versions;
      try {
        versions = await fetchRemoteHistory();
        online = true;
      } catch (_) {
        var db = await openDatabase();
        versions = await getLocalVersions(db);
      }
      if (!versions.length) {
        var empty = document.createElement("p");
        empty.className = "wce-history-empty";
        empty.textContent = "No checkpoints yet.";
        historyList.appendChild(empty);
        return;
      }
      versions.forEach(function (version) {
        var row = document.createElement("article");
        row.className = "wce-version";
        var copy = document.createElement("div");
        var label = document.createElement("strong");
        label.textContent = version.note || "Saved checkpoint";
        var meta = document.createElement("span");
        if (version.sha) {
          meta.textContent = timeLabel(version.savedAt) + " · " + (version.githubAuthor || "GitHub") + " · " + version.sha.slice(0, 7);
        } else {
          meta.textContent = timeLabel(version.savedAt) + " · " + (Array.isArray(version.messages) ? version.messages.length : 0).toLocaleString() + " messages";
        }
        copy.append(label, meta);
        var restore = document.createElement("button");
        restore.type = "button"; restore.textContent = "Restore";
        restore.addEventListener("click", function () { restoreVersion(version); });
        row.append(copy, restore); historyList.appendChild(row);
      });
    } catch (error) {
      var failed = document.createElement("p");
      failed.className = "wce-history-empty";
      failed.textContent = error.message || "Could not load history.";
      historyList.appendChild(failed);
    }
  }

  async function toggleHistory(show) {
    var visible = typeof show === "boolean" ? show : historyPanel.hidden;
    historyPanel.hidden = !visible;
    historyButton.setAttribute("aria-expanded", visible ? "true" : "false");
    if (visible) await renderHistory();
  }

  modebar.addEventListener("click", function (event) {
    var button = event.target.closest("[data-wce-mode]");
    if (button) setMode(button.dataset.wceMode, true);
  });

  composerText.addEventListener("input", function () {
    composeCount.textContent = wordCount(composerText.value).toLocaleString() + " words";
    if (!composerPreview.hidden) renderComposerPreview();
  });

  composerText.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!composerText.value.trim()) { setStatus("Write a message before adding it", "error"); composerText.focus(); return; }
    var before = messages.map(function (item) { return Object.assign({}, item); });
    messages.push({
      id: uid(),
      author: composerAuthor.value.trim() || "User",
      timestamp: new Date().toISOString(),
      content: composerText.value,
      replyTo: replyingTo?.id || "",
      replyAuthor: replyingTo?.author || "",
      replyExcerpt: replyingTo?.excerpt || ""
    });
    displayLimit = Math.max(displayLimit, 150);
    composerText.value = ""; composeCount.textContent = "0 words"; composerPreview.innerHTML = ""; composerPreview.hidden = true; composerPreviewButton.setAttribute("aria-expanded", "false"); composerPreviewButton.textContent = "Preview"; clearReplyTarget();
    renderMessages({ pinBottom: true });
    await persistChange("Before adding a new archive message", before, { skipRender: true });
  });

  fileInput.addEventListener("change", function () { addAttachments(fileInput.files); });

  workspace.addEventListener("click", function (event) {
    var button = event.target.closest("[data-wce-action]");
    if (!button) return;
    var action = button.dataset.wceAction;
    if (action === "checkpoint") saveCheckpoint();
    if (action === "history") toggleHistory();
    if (action === "history-close") toggleHistory(false);
    if (action === "more") { displayLimit += 150; renderMessages({ preserveViewport: true }); }
    if (action === "attach") fileInput.click();
    if (action === "reply-cancel") { clearReplyTarget(); composerText.focus(); }
    if (action === "composer-preview") { composerPreview.hidden = !composerPreview.hidden; composerPreviewButton.setAttribute("aria-expanded", composerPreview.hidden ? "false" : "true"); composerPreviewButton.textContent = composerPreview.hidden ? "Preview" : "Hide preview"; if (!composerPreview.hidden) renderComposerPreview(); }
  });

  setMode("edit", false);
})();
