# AI Assistant — Feature Upgrade

This version adds:

- Persistent chat history using browser localStorage
- Multiple saved conversations in the sidebar
- File upload and text extraction for TXT, MD, CSV, JSON, JS, HTML, CSS, XML, PDF and DOCX
- Image upload with vision analysis
- Voice input using the browser Speech Recognition API
- Text-to-speech using the browser Speech Synthesis API
- Improved responsive/mobile layout with a mobile sidebar

## Setup

1. Keep your existing `Backend/.env` file with your OpenRouter API key, or create it from `.env.example`.
2. Open a terminal inside `Backend`.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:5000`.

## Environment variables

```env
OPENROUTER_API_KEY=your_key_here
PORT=5000
MODEL=minimax/minimax-m3:free
VISION_MODEL=google/gemma-4-26b-a4b-it:free
```

`MODEL` is used for normal text chat. `VISION_MODEL` is used when an image is attached.

Voice input and text-to-speech are browser features, so they do not require another API key. Browser permissions may be requested for microphone access.
