/**
 * Saturn AI - Background Service Worker (The Brain)
 * Implements ReAct loop, Gemini API function calling, tab management,
 * and asynchronous communication with Content Script and Popup UI.
 */

// Tool declarations for Gemini API
const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "click_element",
        description: "Click an interactive element on the web page identified by its unique data-llm-id.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: {
              type: "STRING",
              description: "The unique data-llm-id of the target element (e.g. 'element-1', 'element-12')."
            }
          },
          required: ["id"]
        }
      },
      {
        name: "fill_text",
        description: "Type text into an input field, search bar, or textarea identified by its data-llm-id.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: {
              type: "STRING",
              description: "The unique data-llm-id of the input field or textarea (e.g. 'element-3')."
            },
            text: {
              type: "STRING",
              description: "The text string to enter into the field."
            }
          },
          required: ["id", "text"]
        }
      },
      {
        name: "navigate_to",
        description: "Navigate the active browser tab to a specified destination URL.",
        parameters: {
          type: "OBJECT",
          properties: {
            url: {
              type: "STRING",
              description: "The absolute destination URL (e.g. 'https://www.google.com', 'https://github.com/trending')."
            }
          },
          required: ["url"]
        }
      },
      {
        name: "scroll_page",
        description: "Scroll the active web page to reveal more elements or view content.",
        parameters: {
          type: "OBJECT",
          properties: {
            direction: {
              type: "STRING",
              description: "Direction to scroll the page.",
              enum: ["down", "up", "top", "bottom"]
            }
          },
          required: ["direction"]
        }
      },
      {
        name: "task_complete",
        description: "Call this tool when the user's objective is completed or the final answer/result is found.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: {
              type: "STRING",
              description: "Detailed summary of what was accomplished, final findings, or answers for the user."
            }
          },
          required: ["message"]
        }
      }
    ]
  }
];

const SYSTEM_INSTRUCTION = `You are Saturn Web Agent, an autonomous AI web assistant powered by Gemini.
Your job is to accomplish the user's task by browsing and interacting with web pages.
You operate in a ReAct (Reasoning + Acting) loop using tool calls:

AVAILABLE TOOLS:
1. navigate_to(url): Go to a website (e.g. https://www.google.com).
2. click_element(id): Click a button, link, or item using its "data-llm-id" (e.g. "element-1").
3. fill_text(id, text): Type text into an input or search field.
4. scroll_page(direction): Scroll 'down', 'up', 'top', or 'bottom' to reveal more content.
5. task_complete(message): Terminate the task and deliver the final answer or summary to the user.

RULES & BEST PRACTICES:
- In each step, examine the provided JSON list of interactive elements, their tags, texts, and attributes.
- Choose EXACTLY ONE tool call that brings you closest to the user's goal.
- When searching: First use 'fill_text' on the search input, then either click the search/submit button or the relevant suggested item.
- If an element is not visible or not found, try scrolling or re-evaluating the page state.
- If an action returned an error, observe the error message and choose an alternate strategy.
- When you have found the requested information or completed the goal, ALWAYS call task_complete(message) with a detailed and helpful response.`;

// In-memory runtime state
let agentState = {
  isRunning: false,
  status: 'idle', // 'idle' | 'reasoning' | 'executing' | 'completed' | 'error'
  statusText: 'Ready',
  currentStep: 0,
  maxSteps: 25,
  activeTabId: null,
  activeTabUrl: '',
  logs: []
};

let abortSignalController = null;

/**
 * Utility: Wait helper
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Append log entry and broadcast to UI & Storage
 */
function addLog(type, message, details = null) {
  const logItem = {
    id: 'log-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toLocaleTimeString(),
    type, // 'info' | 'thought' | 'action' | 'success' | 'error' | 'complete'
    message,
    details: details ? (typeof details === 'object' ? JSON.stringify(details, null, 2) : String(details)) : null
  };

  agentState.logs.push(logItem);
  if (agentState.logs.length > 80) {
    agentState.logs.shift(); // Keep bounded
  }

  // Update storage & notify popup if open
  chrome.storage.local.set({ saturn_agent_state: agentState }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'AGENT_STATE_UPDATE', state: agentState }).catch(() => {
    // Popup might not be open, ignore error
  });
}

/**
 * Update agent status
 */
function updateStatus(status, statusText) {
  agentState.status = status;
  agentState.statusText = statusText;
  chrome.storage.local.set({ saturn_agent_state: agentState }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'AGENT_STATE_UPDATE', state: agentState }).catch(() => {});
}

/**
 * Ensure content script is injected and responding in the target tab.
 */
async function ensureContentScript(tabId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (response && response.status === 'PONG') {
        return true;
      }
    } catch (err) {
      // Content script may not be injected yet
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });
        await delay(300);
      } catch (injectErr) {
        // Tab might be chrome:// or restricted
      }
    }
    await delay(300);
  }
  return false;
}

/**
 * Wait for a tab to finish loading after navigation.
 */
function waitForTabLoad(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Query page state from content script.
 */
async function getPageState(tabId) {
  const ready = await ensureContentScript(tabId);
  if (!ready) {
    return {
      error: 'Cannot communicate with content script. The page may be restricted (e.g. chrome:// or Web Store) or still loading.'
    };
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' });
    if (res && res.success) {
      return res.state;
    }
    return { error: res?.error || 'Failed to extract page state' };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Send request to Gemini REST API
 */
async function callGeminiApi(apiKey, model, contents, signal) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: contents,
    tools: GEMINI_TOOLS,
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
    },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    let errBody = '';
    try {
      const errJson = await response.json();
      errBody = errJson.error?.message || JSON.stringify(errJson);
    } catch {
      errBody = await response.text();
    }
    throw new Error(`Gemini API Error (${response.status}): ${errBody}`);
  }

  return await response.json();
}

/**
 * Core ReAct Autonomous Loop
 */
async function runAgentLoop({ prompt, apiKey, model = 'gemini-3.8-flash' }) {
  if (agentState.isRunning) {
    addLog('error', 'Agent is already running a task.');
    return;
  }

  // Find active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.id) {
    addLog('error', 'No active tab found. Please open a webpage and try again.');
    return;
  }

  // Prevent running on internal Chrome pages
  if (activeTab.url && (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://'))) {
    addLog('error', 'Cannot run on chrome:// or extension pages. Please navigate to a standard web page.');
    return;
  }

  abortSignalController = new AbortController();
  const signal = abortSignalController.signal;

  agentState.isRunning = true;
  agentState.currentStep = 0;
  agentState.activeTabId = activeTab.id;
  agentState.activeTabUrl = activeTab.url;
  agentState.logs = [];

  updateStatus('reasoning', 'Starting agent loop...');
  addLog('info', `Target tab: ${activeTab.title || activeTab.url}`);
  addLog('info', `User Prompt: "${prompt}"`);

  // Initialize Gemini conversation history
  const contents = [];

  try {
    while (agentState.isRunning && agentState.currentStep < agentState.maxSteps) {
      if (signal.aborted) break;

      agentState.currentStep++;
      updateStatus('reasoning', `Step ${agentState.currentStep}/${agentState.maxSteps}: Analyzing page...`);

      // 1. Get current page state
      const pageState = await getPageState(agentState.activeTabId);
      if (pageState.error) {
        addLog('error', `DOM Inspection warning: ${pageState.error}`);
      }

      // 2. Prepare user message / prompt turn
      if (agentState.currentStep === 1) {
        // First turn: Prompt + initial DOM state
        const initialUserPrompt = `TASK OBJECTIVE: "${prompt}"

CURRENT PAGE INFO:
- URL: ${pageState.url || activeTab.url}
- Title: ${pageState.title || 'Unknown'}
- Scroll: Y=${pageState.scrollPosition?.y || 0} / Height=${pageState.scrollPosition?.documentHeight || 0}
- Interactive Elements Found: ${pageState.returnedElementsCount || 0}

PAGE INTERACTIVE ELEMENTS (JSON):
${JSON.stringify(pageState.elements || [], null, 2)}

Please inspect the page and invoke the appropriate tool to advance the task.`;

        contents.push({
          role: 'user',
          parts: [{ text: initialUserPrompt }]
        });
      }

      addLog('thought', `Consulting Gemini (${model})...`);

      // 3. Call Gemini API
      let geminiResponse;
      try {
        geminiResponse = await callGeminiApi(apiKey, model, contents, signal);
      } catch (apiErr) {
        if (signal.aborted) break;
        addLog('error', `API Request Failed: ${apiErr.message}`);
        updateStatus('error', 'API error occurred');
        break;
      }

      if (signal.aborted) break;

      // 4. Parse Gemini candidate response
      const candidate = geminiResponse.candidates?.[0];
      if (!candidate || !candidate.content) {
        throw new Error('Received empty or blocked response from Gemini API.');
      }

      const modelParts = candidate.content.parts || [];
      // Append model turn to conversation history
      contents.push({
        role: 'model',
        parts: modelParts
      });

      // Extract text thoughts (if any)
      const textParts = modelParts.filter(p => p.text).map(p => p.text).join('\n').trim();
      if (textParts) {
        addLog('thought', textParts);
      }

      // Check for functionCall
      const functionCallPart = modelParts.find(p => p.functionCall);
      if (!functionCallPart || !functionCallPart.functionCall) {
        // Model didn't call a function, ask it to make a decision
        addLog('info', 'Model gave text response without tool call. Requesting action...');
        contents.push({
          role: 'user',
          parts: [{
            text: 'Please execute an action using one of the available tools (click_element, fill_text, navigate_to, scroll_page, or task_complete).'
          }]
        });
        continue;
      }

      const { name: funcName, args: funcArgs } = functionCallPart.functionCall;
      updateStatus('executing', `Executing: ${funcName}`);
      addLog('action', `Tool Call: ${funcName}(${JSON.stringify(funcArgs)})`);

      // 5. Handle task_complete
      if (funcName === 'task_complete') {
        const completionMsg = funcArgs.message || 'Task marked complete.';
        addLog('complete', completionMsg);
        updateStatus('completed', 'Task Complete');
        agentState.isRunning = false;
        break;
      }

      // 6. Handle navigate_to
      let executionResult = null;
      if (funcName === 'navigate_to') {
        let destUrl = funcArgs.url || '';
        if (!/^https?:\/\//i.test(destUrl)) {
          destUrl = 'https://' + destUrl;
        }

        try {
          addLog('info', `Navigating tab to: ${destUrl}`);
          await chrome.tabs.update(agentState.activeTabId, { url: destUrl });
          await waitForTabLoad(agentState.activeTabId);
          // Wait additional settling time for client-side hydration
          await delay(1200);

          agentState.activeTabUrl = destUrl;
          executionResult = {
            status: 'success',
            message: `Successfully navigated to ${destUrl}`
          };
          addLog('success', executionResult.message);
        } catch (navErr) {
          executionResult = {
            status: 'error',
            error: `Failed to navigate to ${destUrl}: ${navErr.message}`
          };
          addLog('error', executionResult.error);
        }
      } else {
        // 7. Route action to content script (click_element, fill_text, scroll_page)
        const ready = await ensureContentScript(agentState.activeTabId);
        if (!ready) {
          executionResult = {
            status: 'error',
            error: 'Could not connect to page content script. Page might be loading or inaccessible.'
          };
          addLog('error', executionResult.error);
        } else {
          try {
            const actionResponse = await chrome.tabs.sendMessage(agentState.activeTabId, {
              type: 'EXECUTE_ACTION',
              action: funcName,
              params: funcArgs
            });

            if (actionResponse && actionResponse.success) {
              executionResult = {
                status: 'success',
                message: actionResponse.message || 'Action executed successfully.'
              };
              addLog('success', executionResult.message);
            } else {
              executionResult = {
                status: 'error',
                error: actionResponse?.error || 'Action failed with unknown error.'
              };
              addLog('error', executionResult.error);
            }
          } catch (cmdErr) {
            executionResult = {
              status: 'error',
              error: `Communication error with content script: ${cmdErr.message}`
            };
            addLog('error', executionResult.error);
          }
        }
      }

      // Small settling delay for DOM mutations / transitions to occur
      await delay(800);

      // 8. Capture updated page state to feed back into Gemini
      const updatedPageState = await getPageState(agentState.activeTabId);

      // 9. Format Gemini FunctionResponse turn
      const functionResponsePayload = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: funcName,
              response: {
                result: executionResult,
                currentPage: {
                  url: updatedPageState.url || agentState.activeTabUrl,
                  title: updatedPageState.title || '',
                  scrollY: updatedPageState.scrollPosition?.y || 0,
                  interactiveElementsCount: updatedPageState.returnedElementsCount || 0,
                  elements: updatedPageState.elements || []
                }
              }
            }
          }
        ]
      };

      contents.push(functionResponsePayload);
    }

    if (agentState.isRunning && agentState.currentStep >= agentState.maxSteps) {
      addLog('info', `Maximum step limit reached (${agentState.maxSteps} steps). Halting agent.`);
      updateStatus('idle', 'Step limit reached');
      agentState.isRunning = false;
    }
  } catch (loopErr) {
    if (!signal.aborted) {
      addLog('error', `Agent Loop Error: ${loopErr.message}`);
      updateStatus('error', 'Execution stopped');
    }
    agentState.isRunning = false;
  } finally {
    if (signal.aborted) {
      addLog('info', 'Agent stopped by user.');
      updateStatus('idle', 'Stopped');
      agentState.isRunning = false;
    }
    chrome.storage.local.set({ saturn_agent_state: agentState }).catch(() => {});
  }
}

/**
 * Message Handler for Popup UI
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_AGENT') {
    const { prompt, apiKey, model } = request;
    if (!apiKey) {
      sendResponse({ success: false, error: 'Google AI Studio API Key is required.' });
      return false;
    }
    if (!prompt) {
      sendResponse({ success: false, error: 'Please enter a task prompt for the agent.' });
      return false;
    }

    runAgentLoop({ prompt, apiKey, model });
    sendResponse({ success: true, message: 'Agent started' });
    return false;
  }

  if (request.type === 'STOP_AGENT') {
    if (abortSignalController) {
      abortSignalController.abort();
    }
    agentState.isRunning = false;
    updateStatus('idle', 'Stopped');
    sendResponse({ success: true, message: 'Agent stopped' });
    return false;
  }

  if (request.type === 'GET_AGENT_STATE') {
    sendResponse({ success: true, state: agentState });
    return false;
  }

  if (request.type === 'CLEAR_LOGS') {
    agentState.logs = [];
    chrome.storage.local.set({ saturn_agent_state: agentState }).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// Restore previous state from storage on service worker wake up
chrome.storage.local.get(['saturn_agent_state'], (result) => {
  if (result.saturn_agent_state) {
    agentState = {
      ...result.saturn_agent_state,
      // If service worker was terminated, ensure isRunning is set to false
      isRunning: false,
      status: 'idle',
      statusText: 'Ready'
    };
  }
});
