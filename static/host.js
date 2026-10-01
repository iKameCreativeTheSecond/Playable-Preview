(() => {
  const pickBtn = document.getElementById("pickBtn");
  const pickFileBtn = document.getElementById("pickFileBtn");
  const dropzone = document.getElementById("dropzone");
  const folderInput = document.getElementById("folderInput");
  const fileInput = document.getElementById("fileInput");
  const entryPicker = document.getElementById("entryPicker");
  const entrySelect = document.getElementById("entrySelect");
  const entryConfirmBtn = document.getElementById("entryConfirmBtn");
  const entryCancelBtn = document.getElementById("entryCancelBtn");
  const sharingPanel = document.getElementById("sharingPanel");
  const statusText = document.getElementById("statusText");
  const dot = sharingPanel.querySelector(".dot");
  const fileCountBadge = document.getElementById("fileCount");
  const linkRow = document.getElementById("linkRow");
  const shareLinkInput = document.getElementById("shareLink");
  const qrImage = document.getElementById("qrImage");
  const copyBtn = document.getElementById("copyBtn");
  const copyIcon = copyBtn.querySelector(".icon-copy");
  const checkIcon = copyBtn.querySelector(".icon-check");
  const stopBtn = document.getElementById("stopBtn");
  const errorMsg = document.getElementById("errorMsg");

  const MIME_TYPES = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    webm: "video/webm",
    wasm: "application/wasm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    txt: "text/plain",
    xml: "application/xml",
  };

  function mimeFor(path) {
    const ext = path.split(".").pop().toLowerCase();
    return MIME_TYPES[ext] || "application/octet-stream";
  }

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  let fileMap = new Map();
  let entryPath = "";
  let ws = null;

  function showError(text) {
    errorMsg.textContent = text;
    errorMsg.hidden = false;
  }

  function clearError() {
    errorMsg.hidden = true;
  }

  function enterIdle() {
    dropzone.hidden = false;
    entryPicker.hidden = true;
    sharingPanel.hidden = true;
    linkRow.hidden = true;
    fileCountBadge.hidden = true;
    folderInput.value = "";
    fileInput.value = "";
    qrImage.src = "";
  }

  function enterConnecting() {
    clearError();
    dropzone.hidden = true;
    entryPicker.hidden = true;
    sharingPanel.hidden = false;
    linkRow.hidden = true;
    fileCountBadge.hidden = true;
    dot.className = "dot";
    statusText.textContent = "Đang kết nối...";
  }

  function enterSharing(shareId, fileCount) {
    dot.className = "dot dot-live";
    statusText.textContent = "Đang chia sẻ";
    fileCountBadge.textContent = `${fileCount} file`;
    fileCountBadge.title = `File chính: ${entryPath}`;
    fileCountBadge.hidden = false;
    shareLinkInput.value = `${location.origin}/p/${shareId}/`;
    qrImage.src = `${location.origin}/qr/${shareId}`;
    linkRow.hidden = false;
  }

  function isHtmlPath(path) {
    const lower = path.toLowerCase();
    return lower.endsWith(".html") || lower.endsWith(".htm");
  }

  function showEntryPicker(candidates) {
    dropzone.hidden = true;
    entryPicker.hidden = false;
    entrySelect.innerHTML = "";
    for (const path of candidates) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      entrySelect.appendChild(option);
    }
  }

  dropzone.addEventListener("click", () => folderInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      folderInput.click();
    }
  });
  pickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    folderInput.click();
  });
  pickFileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  folderInput.addEventListener("change", () => {
    const files = Array.from(folderInput.files);
    if (files.length === 0) return;

    fileMap = new Map();
    const rootPrefix = files[0].webkitRelativePath.split("/")[0] + "/";
    for (const file of files) {
      const rel = file.webkitRelativePath.startsWith(rootPrefix)
        ? file.webkitRelativePath.slice(rootPrefix.length)
        : file.webkitRelativePath;
      fileMap.set(rel, file);
    }

    const htmlCandidates = [...fileMap.keys()].filter(isHtmlPath);
    if (htmlCandidates.length === 0) {
      showError("Không tìm thấy file .html nào trong thư mục đã chọn.");
      folderInput.value = "";
      return;
    }

    const defaultEntry = htmlCandidates.find((p) => p.toLowerCase() === "index.html");
    if (defaultEntry) {
      entryPath = defaultEntry;
      startSharing(files.length);
    } else if (htmlCandidates.length === 1) {
      entryPath = htmlCandidates[0];
      startSharing(files.length);
    } else {
      showEntryPicker(htmlCandidates);
    }
  });

  entryConfirmBtn.addEventListener("click", () => {
    entryPath = entrySelect.value;
    startSharing(fileMap.size);
  });

  entryCancelBtn.addEventListener("click", () => {
    enterIdle();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    fileMap = new Map([[file.name, file]]);
    entryPath = file.name;
    startSharing(1);
  });

  function startSharing(fileCount) {
    enterConnecting();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/host`);

    ws.addEventListener("message", async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "registered") {
        enterSharing(msg.share_id, fileCount);
        return;
      }

      if (msg.type === "request") {
        const lookupPath = msg.path === "" ? entryPath : msg.path;
        const file = fileMap.get(lookupPath);
        if (!file) {
          ws.send(JSON.stringify({ type: "response", id: msg.id, status: 404 }));
          return;
        }
        const buffer = await file.arrayBuffer();
        ws.send(
          JSON.stringify({
            type: "response",
            id: msg.id,
            status: 200,
            contentType: mimeFor(lookupPath),
            bodyBase64: arrayBufferToBase64(buffer),
          })
        );
      }
    });

    ws.addEventListener("close", () => {
      enterIdle();
    });

    ws.addEventListener("error", () => {
      showError("Lỗi kết nối tới server.");
      enterIdle();
    });
  }

  stopBtn.addEventListener("click", () => {
    if (ws) ws.close();
    else enterIdle();
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareLinkInput.value);
    } catch (e) {
      shareLinkInput.select();
      document.execCommand("copy");
    }
    copyIcon.hidden = true;
    checkIcon.hidden = false;
    setTimeout(() => {
      copyIcon.hidden = false;
      checkIcon.hidden = true;
    }, 1500);
  });
})();
