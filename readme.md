# Document Q&A Chatbot

A single-page document Q&A app deployed as one Netlify project: static frontend plus its own serverless backend in the same repository.

Users upload PDF or DOCX files, ask questions, and get answers grounded in the relevant document passages.

## Netlify version

The current app is a Netlify-native rewrite of the original Streamlit application.

Features:

- Upload one or more PDF or DOCX files
- Parse and chunk documents in the browser
- Generate embeddings locally in the browser
- Semantic similarity search over document passages
- Ask questions through a Groq-backed chat endpoint
- Chat history stored in browser `localStorage`
- Expandable "Document Similarity Search" results for every answer
- Dark theme matching the original app

### Architecture

```
public/index.html        single-page UI
public/styles.css        dark theme
public/app.js            parsing, chunking, embeddings, retrieval, chat UI
netlify/functions/chat.mjs  Groq proxy with rate limiting
netlify.toml             Netlify publish/function configuration
```

Documents never leave the browser. Only the retrieved passages and the question are sent to `/api/chat`. The Groq API key is stored as a Netlify environment variable and is never exposed to the client.

Embeddings are generated locally with `@huggingface/transformers` and `onnx-community/all-MiniLM-L6-v2-ONNX`, so no Google API key is required.

### Local development

Requirements:

- Node.js 22+
- A valid Groq API key

Create a `.env` file:

```env
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-20b
```

Install or run the Netlify CLI, then start the dev server:

```bash
npm run dev
```

Open `http://localhost:8888`.

`GROQ_MODEL` is optional. The default is `openai/gpt-oss-20b`.

### Deploy to Netlify

1. Push the repository to GitHub, GitLab, or Bitbucket.
2. In Netlify, choose **Add new site** and import the repository.
3. Use the settings from `netlify.toml`:
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Build command: leave empty
4. Add the environment variable `GROQ_API_KEY` in the Netlify UI.
5. Optionally add `GROQ_MODEL`.
6. Deploy.

The chat function includes a rate limit of 20 requests per 60 seconds per visitor to protect the shared key.

### Notes and limitations

- The embedding model is downloaded to the browser on first use, roughly 25 MB.
- Scanned/image-only PDFs require OCR before upload.
- Legacy binary `.doc` files are not supported; save them as `.docx`.
- Chat history is per browser and is not shared between users.
- Very large documents take longer to process because embedding runs locally.
- The Netlify function request limit does not affect document uploads because files are processed in the browser.

## Legacy Streamlit version

The original Streamlit application is still present in `app2.py` and `database.py`.

It requires both Groq and Google API keys:

```env
GROQ_API_KEY=your_groq_api_key
GOOGLE_API_KEY=your_google_api_key
```

Run it with:

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
streamlit run app2.py
```

The legacy version uses FAISS, SQLite, and Google embeddings, but it cannot be hosted on Netlify because Netlify does not run Python/Streamlit servers.
