/**
 * Saturn AI - Content Script (The Eyes and Hands)
 * Scans active DOM, extracts interactive elements with custom tags,
 * executes native browser actions, and monitors dynamic SPA updates.
 */

(function () {
  // Prevent duplicate initialization
  if (window.__saturnAgentInitialized) {
    return;
  }
  window.__saturnAgentInitialized = true;

  let elementCounter = 0;
  const elementMap = new Map(); // id -> Element
  let mutationTimeout = null;

  // Inject visual indicator styles for agent actions
  const styleEl = document.createElement('style');
  styleEl.id = 'saturn-agent-styles';
  styleEl.textContent = `
    .saturn-highlight-pulse {
      outline: 3px solid #6366f1 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.8), inset 0 0 15px rgba(6, 182, 212, 0.4) !important;
      transition: all 0.3s ease-in-out !important;
      animation: saturnGlow 1.2s ease-in-out infinite alternate !important;
    }
    @keyframes saturnGlow {
      from { outline-color: #6366f1; box-shadow: 0 0 10px rgba(99, 102, 241, 0.6); }
      to { outline-color: #06b6d4; box-shadow: 0 0 20px rgba(6, 182, 212, 0.9); }
    }
    .saturn-tag-badge {
      position: absolute;
      background: linear-gradient(135deg, #4f46e5, #06b6d4);
      color: #ffffff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483647;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }
  `;
  document.head ? document.head.appendChild(styleEl) : document.documentElement.appendChild(styleEl);

  /**
   * Check if an element is genuinely visible to the user.
   */
  function isElementVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;

    // Check display, visibility, opacity
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      el.hidden ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }

    // Check size & bounding box
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Check if element is completely off-screen beyond reasonable scroll
    if (rect.bottom < -500 || rect.top > (window.innerHeight + 10000)) {
      return false;
    }

    return true;
  }

  /**
   * Clean text content to keep JSON payload compact and informative.
   */
  function cleanText(str, maxLength = 100) {
    if (!str) return '';
    const cleaned = str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned.length > maxLength) {
      return cleaned.slice(0, maxLength) + '...';
    }
    return cleaned;
  }

  /**
   * Tag and extract all interactive elements on the page.
   */
  function scanInteractiveElements() {
    const selector = [
      'a[href]',
      'button',
      '[role="button"]',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="searchbox"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const nodes = document.querySelectorAll(selector);
    const elementsData = [];
    const currentVisibleIds = new Set();

    let index = 1;
    nodes.forEach((el) => {
      // Exclude script, style, SVG sub-elements, or our own highlight nodes
      if (
        el.tagName === 'SCRIPT' ||
        el.tagName === 'STYLE' ||
        el.tagName === 'NOSCRIPT' ||
        el.closest('#saturn-agent-styles') ||
        el.classList.contains('saturn-tag-badge')
      ) {
        return;
      }

      if (!isElementVisible(el)) return;

      // Assign or reuse stable custom attribute
      let llmId = el.getAttribute('data-llm-id');
      if (!llmId) {
        llmId = `element-${index}`;
        el.setAttribute('data-llm-id', llmId);
      }
      index++;

      elementMap.set(llmId, el);
      currentVisibleIds.add(llmId);

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag);
      const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
      
      // Extract text content safely without massive children dumps
      let text = '';
      if (tag === 'input' || tag === 'textarea') {
        text = el.placeholder || el.value || '';
      } else {
        // Direct text preferred, or innerText truncated
        text = el.innerText || el.textContent || '';
      }
      text = cleanText(text, 100);

      const rect = el.getBoundingClientRect();
      const elementInfo = {
        id: llmId,
        tag: tag,
        type: type,
        text: text,
        ariaLabel: cleanText(ariaLabel, 60),
        placeholder: el.placeholder ? cleanText(el.placeholder, 60) : undefined,
        value: (type === 'password') ? '[PROTECTED]' : (el.value ? cleanText(el.value, 60) : undefined),
        href: el.href ? (el.pathname ? el.pathname + el.search : el.href.slice(0, 80)) : undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        checked: el.checked || el.getAttribute('aria-checked') === 'true',
        inViewport: (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        )
      };

      // Remove undefined keys to keep payload minimal
      Object.keys(elementInfo).forEach(key => elementInfo[key] === undefined && delete elementInfo[key]);

      elementsData.push(elementInfo);
    });

    // Clean up stale IDs from map
    for (const [id] of elementMap) {
      if (!currentVisibleIds.has(id)) {
        elementMap.delete(id);
      }
    }

    // Limit maximum elements sent to LLM to prevent context bloat (prefer viewport elements)
    elementsData.sort((a, b) => (b.inViewport ? 1 : 0) - (a.inViewport ? 1 : 0));
    const cappedElements = elementsData.slice(0, 160);

    return {
      url: window.location.href,
      title: document.title || 'Untitled Page',
      totalInteractiveElements: elementsData.length,
      returnedElementsCount: cappedElements.length,
      scrollPosition: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        documentHeight: document.documentElement.scrollHeight
      },
      elements: cappedElements
    };
  }

  /**
   * Dynamic Observer: Watches for DOM changes in SPAs and updates tags.
   */
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    for (const m of mutations) {
      if (m.target && m.target.id === 'saturn-agent-styles') continue;
      if (m.target && m.target.classList && m.target.classList.contains('saturn-highlight-pulse')) continue;
      shouldUpdate = true;
      break;
    }

    if (shouldUpdate) {
      if (mutationTimeout) clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        // Light refresh of elements in DOM
        scanInteractiveElements();
      }, 300);
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled']
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled']
      });
    });
  }

  /**
   * Temporarily highlight an element to give visual confirmation of agent actions.
   */
  function flashHighlight(element) {
    if (!element) return;
    element.classList.add('saturn-highlight-pulse');
    setTimeout(() => {
      element.classList.remove('saturn-highlight-pulse');
    }, 1500);
  }

  /**
   * Hands - Execute Action
   */
  async function executeAction(action, params) {
    const { id, text, direction } = params || {};

    if (action === 'click_element') {
      const el = elementMap.get(id) || document.querySelector(`[data-llm-id="${id}"]`);
      if (!el) {
        return {
          success: false,
          error: `Element "${id}" was not found on the page. The page may have re-rendered or the element may not exist. Please check the latest page state.`
        };
      }

      try {
        // Scroll smoothly into view
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        flashHighlight(el);
        await new Promise(r => setTimeout(r, 200));

        // Focus
        el.focus();

        // Dispatch realistic sequence of mouse/pointer events for modern SPA frameworks (React/Vue/Angular)
        const mouseOpts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
        el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        el.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
        el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        el.click();

        return {
          success: true,
          message: `Successfully clicked element "${id}" (${el.tagName.toLowerCase()}${el.innerText ? ' - "' + cleanText(el.innerText, 30) + '"' : ''})`
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to click element "${id}": ${err.message}`
        };
      }
    }

    if (action === 'fill_text') {
      const el = elementMap.get(id) || document.querySelector(`[data-llm-id="${id}"]`);
      if (!el) {
        return {
          success: false,
          error: `Input element "${id}" was not found on the page.`
        };
      }

      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashHighlight(el);
        await new Promise(r => setTimeout(r, 150));

        el.focus();

        // Native value setter to ensure React / Vue form state binding triggers correctly
        const valToSet = text !== undefined ? String(text) : '';
        const isInput = el.tagName === 'INPUT';
        const isTextArea = el.tagName === 'TEXTAREA';

        if (isInput || isTextArea) {
          const proto = isInput ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(el, valToSet);
          } else {
            el.value = valToSet;
          }
        } else if (el.isContentEditable) {
          el.innerText = valToSet;
        } else {
          el.value = valToSet;
        }

        // Trigger input and change events
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

        return {
          success: true,
          message: `Successfully filled text into element "${id}"`
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to fill text into element "${id}": ${err.message}`
        };
      }
    }

    if (action === 'scroll_page') {
      try {
        const scrollAmount = window.innerHeight * 0.75;
        const dir = (direction || 'down').toLowerCase();

        if (dir === 'down') {
          window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        } else if (dir === 'up') {
          window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        } else if (dir === 'top') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (dir === 'bottom') {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        }

        await new Promise(r => setTimeout(r, 400));

        return {
          success: true,
          message: `Scrolled page ${dir}. New scroll Y: ${Math.round(window.scrollY)}px`
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to scroll page: ${err.message}`
        };
      }
    }

    return {
      success: false,
      error: `Unknown action: "${action}"`
    };
  }

  /**
   * Listen for commands from the background service worker.
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PING') {
      sendResponse({ status: 'PONG', url: window.location.href });
      return false;
    }

    if (request.type === 'GET_PAGE_STATE') {
      try {
        const state = scanInteractiveElements();
        sendResponse({ success: true, state });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    if (request.type === 'EXECUTE_ACTION') {
      executeAction(request.action, request.params).then(result => {
        sendResponse(result);
      });
      return true; // Keep channel open for async response
    }

    return false;
  });

  // Initial scan
  scanInteractiveElements();
})();
