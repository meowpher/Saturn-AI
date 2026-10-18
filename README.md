# Saturn AI - LLM-Powered Autonomous Web Agent
**Manifest V3 Chrome Extension powered by Gemini API (`gemini-3.8-flash`)**

Saturn AI is an autonomous web navigation agent that inspects active web pages, reasons through interactive elements, and executes actions (clicks, inputs, scrolling, navigation) using a ReAct (Reasoning + Acting) loop.

---

## 🚀 Key Features

- **DOM State Compression & Tagging:** Dynamic scan identifies visible interactive elements (`<button>`, `<a>`, `<input>`, `<textarea>`, ARIA roles) and injects unique `data-llm-id` tags without bloating context.
- **Visual Feedback:** Pulses glowing cosmic indicators on elements currently being inspected or interacted with on live pages.
- **ReAct Autonomous Loop:** Multi-turn tool calling with Google AI Studio's `gemini-3.8-flash` REST API (`click_element`, `fill_text`, `navigate_to`, `scroll_page`, `task_complete`).
- **SPA & Dynamic DOM Support:** Listens to `MutationObserver` events to update element maps as pages dynamically render.
- **Resilient Error Recovery:** If an element is missing or fails to interact, the content script catches the error and reports it back to Gemini for self-correction.
- **Sleek Modern UI:** Glassmorphic dark terminal interface featuring real-time activity streaming, step progress counter, preset prompts, and API key management.

---

## 📁 File Structure

```
Saturn/
├── manifest.json         # Manifest V3 extension configuration
├── popup.html            # Extension popup markup
├── popup.css             # Glassmorphic dark theme design
├── popup.js              # UI interaction & log streaming controller
├── background.js         # Service worker, ReAct loop & Gemini API engine
├── content.js            # DOM parser, tagger, action executor & observer
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md             # Documentation & setup guide
```

---

## ⚡ How to Run

1. Click the **Saturn AI** icon in your toolbar to open the extension popup.
2. In the **Gemini API Key** section, paste your key from [Google AI Studio](https://aistudio.google.com/app/apikey) and click **Save**.
3. Navigate to any website in Chrome (e.g. `https://www.google.com`, `https://github.com/trending`, or `https://news.ycombinator.com`).
4. Type your objective in natural language or click one of the quick suggestions:
   - *"Search Google for James Webb Telescope and summarize the latest discovery."*
   - *"Go to github.com/trending and find the top JavaScript repository."*
   - *"Find the search bar, type 'Artificial Intelligence', and click Search."*
5. Click **Run Agent** and watch the agent reason, interact, and stream its activity in real time.
