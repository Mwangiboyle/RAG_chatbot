const STORAGE_KEY = "rag-chatbot-history-v1";
const MAX_HISTORY_MESSAGES = 80;
const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH_SIZE = 16;
const TOP_K = 4;
const LINKS = {
  transformers: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4",
  pdfjs: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs",
  pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs",
};

const elements = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  fileList: document.getElementById("fileList"),
  documentCount: document.getElementById("documentCount"),
  submitButton: document.getElementById("submitButton"),
  clearDocumentsButton: document.getElementById("clearDocumentsButton"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
  status: document.getElementById("status"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),
  questionInput: document.getElementById("questionInput"),
  sendButton: document.getElementById("sendButton"),
  chatForm: document.getElementById("chatForm"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  chatSubtitle: document.getElementById("chatSubtitle"),
};

const state = {
  files: [],
  chunks: [],
  vectors: [],
  extractor: null,
  pdfjs: null,
  processing: false,
  sending: false,
  history: loadHistory(),
};

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          (item.role === "user" || item.role === "bot") &&
          typeof item.text === "string",
      )
      .slice(-MAX_HISTORY_MESSAGES);
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    const compact = state.history
      .slice(-MAX_HISTORY_MESSAGES)
      .map(({ role, text }) => ({ role, text }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch {
    return;
  }
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status${type ? ` ${type}` : ""}`;
}

function setProgress(value) {
  if (value === null) {
    elements.progressWrap.hidden = true;
    elements.progressBar.style.width = "0%";
    return;
  }
  elements.progressWrap.hidden = false;
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function getExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isSupported(file) {
  const extension = getExtension(file.name);
  return extension === "pdf" || extension === "docx";
}

function invalidateIndex() {
  state.chunks = [];
  state.vectors = [];
}

function renderFileList() {
  elements.fileList.replaceChildren();

  state.files.forEach((file, index) => {
    const item = document.createElement("li");
    item.className = "file-item";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(file.size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => {
      if (state.processing) return;
      state.files.splice(index, 1);
      invalidateIndex();
      renderFileList();
      updateControls();
      setStatus(
        state.files.length
          ? "Files changed. Submit again to rebuild the index."
          : "Add a document to get started.",
        state.files.length ? "working" : "",
      );
    });

    item.append(name, size, remove);
    elements.fileList.append(item);
  });
}

function updateControls() {
  const ready = state.vectors.length > 0 && state.vectors.length === state.chunks.length;
  const hasFiles = state.files.length > 0;

  elements.submitButton.disabled = state.processing || !hasFiles;
  elements.clearDocumentsButton.disabled =
    state.processing || (!hasFiles && state.chunks.length === 0);
  elements.questionInput.disabled = !ready || state.sending || state.processing;
  elements.sendButton.disabled = !ready || state.sending || state.processing;
  elements.sendButton.textContent = state.sending ? "Thinking..." : "Send";
  elements.documentCount.textContent = `${state.files.length} file${
    state.files.length === 1 ? "" : "s"
  }`;

  if (ready) {
    const fileCount = new Set(state.chunks.map((chunk) => chunk.source)).size;
    elements.chatSubtitle.textContent = `Ready: ${state.chunks.length} passages from ${fileCount} file${
      fileCount === 1 ? "" : "s"
    }.`;
  } else {
    elements.chatSubtitle.textContent =
      "Submit a document to start asking questions.";
  }
}

function addFiles(fileList) {
  if (state.processing) return;

  const incoming = Array.from(fileList || []);
  const accepted = [];
  const rejected = [];

  for (const file of incoming) {
    if (!isSupported(file)) {
      rejected.push(file.name);
      continue;
    }

    const duplicate = state.files.some(
      (existing) =>
        existing.name === file.name &&
        existing.size === file.size &&
        existing.lastModified === file.lastModified,
    );
    if (!duplicate) accepted.push(file);
  }

  if (accepted.length) {
    const hadIndex = state.chunks.length > 0;
    state.files.push(...accepted);
    if (hadIndex) invalidateIndex();
    renderFileList();
    updateControls();
    setStatus(
      hadIndex
        ? "Files changed. Submit again to rebuild the index."
        : "Files ready. Click Submit your document.",
      hadIndex ? "working" : "",
    );
  }

  if (rejected.length) {
    setStatus(
      `Skipped unsupported file${rejected.length === 1 ? "" : "s"}: ${rejected.join(
        ", ",
      )}. Use PDF or DOCX.`,
      "error",
    );
  } else if (!accepted.length && incoming.length) {
    setStatus("Those files are already in the list.", "");
  }
}

async function getPdfJs() {
  if (state.pdfjs) return state.pdfjs;
  const pdfjs = await import(LINKS.pdfjs);
  pdfjs.GlobalWorkerOptions.workerSrc = LINKS.pdfWorker;
  state.pdfjs = pdfjs;
  return pdfjs;
}

async function readPdf(file) {
  const pdfjs = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(text);
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await pdf.destroy();
  }
}

async function readDocx(file) {
  if (!window.mammoth) {
    throw new Error("The DOCX parser could not be loaded. Check your connection.");
  }
  const result = await window.mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
  return result.value || "";
}

async function readFile(file) {
  const extension = getExtension(file.name);
  if (extension === "pdf") return readPdf(file);
  if (extension === "docx") return readDocx(file);
  if (extension === "doc") {
    throw new Error(
      `Legacy .doc files are not supported (${file.name}). Save it as .docx first.`,
    );
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

function chunkText(text) {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return [];

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);

    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
        window.lastIndexOf("; "),
      ];
      const bestBreak = Math.max(...candidates);
      if (bestBreak > CHUNK_SIZE * 0.5) end = start + bestBreak + 1;
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;

    const nextStart = end - CHUNK_OVERLAP;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

async function ensureExtractor() {
  if (state.extractor) return state.extractor;

  setStatus("Loading the embedding model. First load may download about 25 MB.", "working");
  setProgress(2);

  const transformers = await import(LINKS.transformers);
  transformers.env.allowLocalModels = false;
  transformers.env.useBrowserCache = true;

  state.extractor = await transformers.pipeline(
    "feature-extraction",
    EMBEDDING_MODEL,
    {
      progress_callback: (info) => {
        if (info.status === "progress_total" && typeof info.progress === "number") {
          const percent = Math.min(14, 2 + Math.round(info.progress * 0.12));
          setProgress(percent);
          setStatus(
            `Loading the embedding model... ${Math.round(info.progress)}%`,
            "working",
          );
        } else if (info.status === "ready") {
          setProgress(14);
        }
      },
    },
  );

  return state.extractor;
}

async function embedTexts(texts, onProgress) {
  const extractor = await ensureExtractor();
  const vectors = [];

  for (let index = 0; index < texts.length; index += EMBED_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBED_BATCH_SIZE);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    const dimensions = output.dims[1];
    const data = output.data;

    for (let row = 0; row < batch.length; row += 1) {
      vectors.push(
        data.slice(row * dimensions, (row + 1) * dimensions),
      );
    }

    if (typeof output.dispose === "function") output.dispose();
    if (onProgress) onProgress(Math.min(index + batch.length, texts.length), texts.length);
  }

  return vectors;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

async function retrieve(question) {
  const [questionVector] = await embedTexts([question]);
  const ranked = state.vectors.map((vector, index) => ({
    index,
    score: cosineSimilarity(questionVector, vector),
  }));

  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, TOP_K).map(({ index, score }) => ({
    ...state.chunks[index],
    score,
  }));
}

async function submitDocuments() {
  if (state.processing || state.files.length === 0) return;

  state.processing = true;
  updateControls();
  setProgress(1);
  setStatus("Preparing documents...", "working");

  try {
    const chunks = [];

    for (let fileIndex = 0; fileIndex < state.files.length; fileIndex += 1) {
      const file = state.files[fileIndex];
      setStatus(
        `Reading ${file.name} (${fileIndex + 1}/${state.files.length})...`,
        "working",
      );
      setProgress(Math.round(2 + (fileIndex / state.files.length) * 10));

      const text = await readFile(file);
      if (!text.trim()) {
        throw new Error(
          `No readable text found in ${file.name}. Scanned PDFs need OCR first.`,
        );
      }

      for (const piece of chunkText(text)) {
        chunks.push({ text: piece, source: file.name });
      }
    }

    if (!chunks.length) {
      throw new Error("No readable text found in the selected files.");
    }

    const vectors = await embedTexts(
      chunks.map((chunk) => chunk.text),
      (done, total) => {
        setProgress(15 + Math.round((done / total) * 84));
        setStatus(`Embedding passages ${done}/${total}...`, "working");
      },
    );

    state.chunks = chunks;
    state.vectors = vectors;
    setProgress(100);
    setStatus(
      `Document submitted successfully. Indexed ${chunks.length} passages.`,
      "success",
    );

    window.setTimeout(() => {
      if (!state.processing) setProgress(null);
    }, 900);
  } catch (error) {
    invalidateIndex();
    setProgress(null);
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.processing = false;
    updateControls();
  }
}

function createSimilarityDetails(sources) {
  const details = document.createElement("details");
  details.className = "similarity";

  const summary = document.createElement("summary");
  summary.textContent = "Document Similarity Search";

  const list = document.createElement("div");
  list.className = "similarity-list";

  sources.forEach((source, index) => {
    const item = document.createElement("div");
    item.className = "similarity-item";

    const head = document.createElement("div");
    head.className = "similarity-head";

    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${source.source || "Document"}`;

    const score = document.createElement("span");
    score.textContent = `Score ${(source.score * 100).toFixed(1)}%`;

    const text = document.createElement("p");
    text.className = "similarity-text";
    text.textContent = source.text;

    head.append(label, score);
    item.append(head, text);
    list.append(item);
  });

  details.append(summary, list);
  return details;
}

function createMessageElement(entry) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${entry.role}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble${entry.error ? " error" : ""}`;

  const text = document.createElement("p");
  text.className = "bubble-text";
  text.textContent = entry.text;
  bubble.append(text);

  if (entry.sources && entry.sources.length) {
    bubble.append(createSimilarityDetails(entry.sources));
  }

  wrapper.append(bubble);
  return wrapper;
}

function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function appendMessage(entry, persist = true) {
  if (elements.emptyState.isConnected) elements.emptyState.remove();
  elements.messages.append(createMessageElement(entry));
  scrollToBottom();

  if (persist) {
    state.history.push(entry);
    if (state.history.length > MAX_HISTORY_MESSAGES) {
      state.history = state.history.slice(-MAX_HISTORY_MESSAGES);
    }
    saveHistory();
  }
}

function renderHistory() {
  elements.messages.replaceChildren();

  if (!state.history.length) {
    elements.messages.append(elements.emptyState);
    return;
  }

  for (const entry of state.history) {
    elements.messages.append(createMessageElement(entry));
  }
  scrollToBottom();
}

function showTyping() {
  const wrapper = document.createElement("div");
  wrapper.className = "message bot";
  wrapper.id = "typingIndicator";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const typing = document.createElement("span");
  typing.className = "typing";
  typing.setAttribute("aria-label", "Assistant is typing");
  for (let index = 0; index < 3; index += 1) {
    typing.append(document.createElement("span"));
  }

  bubble.append(typing);
  wrapper.append(bubble);
  elements.messages.append(wrapper);
  scrollToBottom();
}

function removeTyping() {
  document.getElementById("typingIndicator")?.remove();
}

async function sendQuestion() {
  const question = elements.questionInput.value.trim();
  if (!question || state.sending || state.vectors.length === 0) return;

  state.sending = true;
  updateControls();
  appendMessage({ role: "user", text: question });

  elements.questionInput.value = "";
  resizeComposer();
  showTyping();

  try {
    const sources = await retrieve(question);
    if (!sources.length) {
      throw new Error("No relevant passages were found in the uploaded documents.");
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        context: sources.map((source) => ({
          text: source.text,
          source: source.source,
        })),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `The chat request failed (${response.status}).`);
    }

    removeTyping();
    appendMessage({
      role: "bot",
      text: data.answer,
      sources,
    });
  } catch (error) {
    removeTyping();
    appendMessage(
      {
        role: "bot",
        text: `Sorry, I could not answer that. ${
          error instanceof Error ? error.message : String(error)
        }`,
        error: true,
      },
      false,
    );
  } finally {
    state.sending = false;
    updateControls();
    elements.questionInput.focus();
  }
}

function resizeComposer() {
  const input = elements.questionInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function clearDocuments() {
  if (state.processing) return;
  state.files = [];
  invalidateIndex();
  elements.fileInput.value = "";
  renderFileList();
  updateControls();
  setProgress(null);
  setStatus("Add a document to get started.");
}

elements.fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
  elements.fileInput.value = "";
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
});

["dragleave", "dragend", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, () => {
    elements.dropZone.classList.remove("dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});

elements.submitButton.addEventListener("click", submitDocuments);
elements.clearDocumentsButton.addEventListener("click", clearDocuments);

elements.clearHistoryButton.addEventListener("click", () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendQuestion();
});

elements.questionInput.addEventListener("input", resizeComposer);

elements.questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

renderFileList();
renderHistory();
updateControls();
