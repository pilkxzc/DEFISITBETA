'use strict';

const { net } = require('electron');

// ── Active agents: winId → AbortController ────────────────────────
const activeAgents = new Map();

// ── Tool definitions (Claude / Anthropic format) ──────────────────
const TOOLS_CLAUDE = [
    {
        name: 'screenshot',
        description: 'Capture a screenshot of the current browser state to see what is on screen',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'click',
        description: 'Click at (x, y) coordinates in the browser viewport',
        input_schema: {
            type: 'object',
            properties: {
                x:      { type: 'number', description: 'X coordinate' },
                y:      { type: 'number', description: 'Y coordinate' },
                button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
            },
            required: ['x', 'y'],
        },
    },
    {
        name: 'type',
        description: 'Type text character by character into the currently focused element',
        input_schema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to type' } },
            required: ['text'],
        },
    },
    {
        name: 'key',
        description: 'Press a keyboard key. Common values: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, F5',
        input_schema: {
            type: 'object',
            properties: { key: { type: 'string', description: 'Key name' } },
            required: ['key'],
        },
    },
    {
        name: 'scroll',
        description: 'Scroll the page at position (x, y). Positive deltaY scrolls down, negative scrolls up.',
        input_schema: {
            type: 'object',
            properties: {
                x:      { type: 'number', description: 'X coordinate' },
                y:      { type: 'number', description: 'Y coordinate' },
                deltaY: { type: 'number', description: 'Scroll amount (positive = down, negative = up)' },
            },
            required: ['x', 'y', 'deltaY'],
        },
    },
    {
        name: 'navigate',
        description: 'Navigate the browser to a URL',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Full URL to navigate to (include https://)' } },
            required: ['url'],
        },
    },
    {
        name: 'wait',
        description: 'Wait for a number of milliseconds before continuing (max 10000)',
        input_schema: {
            type: 'object',
            properties: { ms: { type: 'number', description: 'Milliseconds to wait' } },
            required: ['ms'],
        },
    },
    {
        name: 'get_dom',
        description: 'Get the simplified DOM structure of the page with CSS selectors, data-testid, aria-label, id attributes. USE THIS FIRST to find elements before clicking. Much more reliable than guessing coordinates.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to scope to (default: body). Use "main" or specific container to reduce output.' },
            },
        },
    },
    {
        name: 'click_selector',
        description: 'Click an element by CSS selector. ALWAYS PREFER THIS over coordinate click. Works even when coordinates are hard to determine. Example: [data-testid="like"], button[aria-label="Like"], #submit',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the element to click' },
                nth:      { type: 'number', description: 'Index if multiple matches exist (0 = first, 1 = second…)' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'type_in',
        description: 'Focus an element by CSS selector and type text into it. More reliable than click + type.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the input/textarea' },
                text:     { type: 'string', description: 'Text to type' },
                clear:    { type: 'boolean', description: 'Clear existing value first (default: false)' },
            },
            required: ['selector', 'text'],
        },
    },
    {
        name: 'js',
        description: 'Evaluate JavaScript in the page context and return the result. Use for reading values, complex interactions, or when other tools are not enough.',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript expression or IIFE to evaluate' },
            },
            required: ['code'],
        },
    },
    {
        name: 'done',
        description: 'Call this tool when the task has been completed successfully',
        input_schema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Summary of what was accomplished' } },
        },
    },
    {
        name: 'fail',
        description: 'Call this tool when the task cannot be completed',
        input_schema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Reason why the task failed or is impossible' } },
        },
    },
];

// ── Tool definitions (Gemini / Google format) ─────────────────────
const TOOLS_GEMINI = [{
    function_declarations: [
        {
            name: 'screenshot',
            description: 'Capture a screenshot of the current browser state to see what is on screen',
            parameters: { type: 'OBJECT', properties: {}, required: [] },
        },
        {
            name: 'click',
            description: 'Click at (x, y) coordinates in the browser viewport',
            parameters: {
                type: 'OBJECT',
                properties: {
                    x:      { type: 'NUMBER', description: 'X coordinate' },
                    y:      { type: 'NUMBER', description: 'Y coordinate' },
                    button: { type: 'STRING', description: 'Mouse button: left, right, middle (default: left)' },
                },
                required: ['x', 'y'],
            },
        },
        {
            name: 'type',
            description: 'Type text into the currently focused element',
            parameters: {
                type: 'OBJECT',
                properties: { text: { type: 'STRING', description: 'Text to type' } },
                required: ['text'],
            },
        },
        {
            name: 'key',
            description: 'Press a keyboard key. Common values: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown',
            parameters: {
                type: 'OBJECT',
                properties: { key: { type: 'STRING', description: 'Key name' } },
                required: ['key'],
            },
        },
        {
            name: 'scroll',
            description: 'Scroll the page. Positive deltaY scrolls down, negative scrolls up.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    x:      { type: 'NUMBER', description: 'X coordinate' },
                    y:      { type: 'NUMBER', description: 'Y coordinate' },
                    deltaY: { type: 'NUMBER', description: 'Scroll amount (positive = down, negative = up)' },
                },
                required: ['x', 'y', 'deltaY'],
            },
        },
        {
            name: 'navigate',
            description: 'Navigate the browser to a URL',
            parameters: {
                type: 'OBJECT',
                properties: { url: { type: 'STRING', description: 'Full URL including https://' } },
                required: ['url'],
            },
        },
        {
            name: 'wait',
            description: 'Wait for milliseconds before continuing (max 10000)',
            parameters: {
                type: 'OBJECT',
                properties: { ms: { type: 'NUMBER', description: 'Milliseconds to wait' } },
                required: ['ms'],
            },
        },
        {
            name: 'get_dom',
            description: 'Get simplified DOM structure with CSS selectors, data-testid, aria-label, id. USE THIS FIRST to find elements. Much more reliable than guessing coordinates.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    selector: { type: 'STRING', description: 'CSS selector to scope to (default: body)' },
                },
                required: [],
            },
        },
        {
            name: 'click_selector',
            description: 'Click element by CSS selector. ALWAYS PREFER over coordinate click. Example: [data-testid="like"], button[aria-label="Like"]',
            parameters: {
                type: 'OBJECT',
                properties: {
                    selector: { type: 'STRING', description: 'CSS selector' },
                    nth:      { type: 'NUMBER', description: 'Index if multiple matches (0=first)' },
                },
                required: ['selector'],
            },
        },
        {
            name: 'type_in',
            description: 'Focus element by CSS selector and type text. More reliable than click + type.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    selector: { type: 'STRING', description: 'CSS selector for input/textarea' },
                    text:     { type: 'STRING', description: 'Text to type' },
                    clear:    { type: 'BOOLEAN', description: 'Clear existing value first' },
                },
                required: ['selector', 'text'],
            },
        },
        {
            name: 'js',
            description: 'Evaluate JavaScript in page context. Use for reading values or complex interactions.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    code: { type: 'STRING', description: 'JavaScript expression or IIFE to evaluate' },
                },
                required: ['code'],
            },
        },
        {
            name: 'done',
            description: 'Call when the task has been completed successfully',
            parameters: {
                type: 'OBJECT',
                properties: { text: { type: 'STRING', description: 'Summary of what was accomplished' } },
                required: ['text'],
            },
        },
        {
            name: 'fail',
            description: 'Call when the task cannot be completed',
            parameters: {
                type: 'OBJECT',
                properties: { text: { type: 'STRING', description: 'Reason why task failed or is impossible' } },
                required: ['text'],
            },
        },
    ],
}];

const SYSTEM_PROMPT = `Ти AI агент що керує браузером. Пріоритет — надійність і швидкість.

ГОЛОВНЕ ПРАВИЛО: ЗАВЖДИ використовуй get_dom + click_selector замість координат!
Координатний click — лише крайній захід якщо selector не спрацював.

Алгоритм для будь-якої взаємодії з елементом:
1. get_dom → знайди data-testid, aria-label, або id потрібного елемента
2. click_selector з цим селектором → надійне натискання
3. screenshot → перевір результат

Типові селектори:
- X/Twitter: [data-testid="like"], [data-testid="reply"], [data-testid="retweet"]
- Кнопки: button[aria-label="..."], button:has-text, input[type="submit"]
- Поля: input[placeholder="..."], textarea[name="..."]
- ID: #element-id

АНТИ-ЦИКЛ (КРИТИЧНО — порушення = провал завдання):
- Отримав DOM? Не викликай get_dom знову — ОДРАЗУ click_selector
- click_selector не знайшов? Спробуй js(), НЕ повторюй get_dom
- Кожен крок ОБОВ'ЯЗКОВО відрізняється від попереднього
- Якщо бачиш "SYSTEM WARNING" — НЕГАЙНО змінюй підхід або виклич fail
- Ліміт: 30 кроків. Досяг ліміту — виклич fail

Правила:
1. Перший крок після navigate — get_dom (не screenshot)
2. click_selector + wait(500) + screenshot для перевірки результату
3. Якщо selector не знайдено — спробуй js() або scroll щоб елемент з'явився
4. НЕ розмірковуй довго — дій. Одне речення думок, потім ІНСТРУМЕНТ
5. Коли завдання виконано — виклич done
6. Якщо неможливо виконати — виклич fail`;

// ── Helpers ───────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, Math.min(Math.max(ms, 0), 10000)));
}

function emit(win, event) {
    if (!win.isDestroyed()) win.webContents.send('agent-event', event);
}

// ── DOM helper ────────────────────────────────────────────────────
const DOM_SCRIPT = `(function(rootSel) {
    const SKIP = new Set(['script','style','svg','noscript','head','meta','link','path','defs','use','symbol']);
    const KEEP_ATTRS = ['data-testid','aria-label','id','href','role','type','placeholder','name','value','data-id'];
    function walk(el, depth) {
        if (depth > 6 || !el || el.nodeType !== 1) return '';
        const tag = el.tagName.toLowerCase();
        if (SKIP.has(tag)) return '';
        const attrs = [];
        for (const a of KEEP_ATTRS) {
            const v = el.getAttribute(a);
            if (v) attrs.push(a + '="' + v.slice(0,80).replace(/"/g,'&quot;') + '"');
        }
        let text = '';
        for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
        text = text.trim().replace(/\\s+/g,' ').slice(0,80);
        const inner = Array.from(el.children).map(c => walk(c, depth+1)).filter(Boolean).join('');
        const attrStr = attrs.length ? ' '+attrs.join(' ') : '';
        if (!inner && !text) return attrs.length ? '<'+tag+attrStr+'/>' : '';
        if (!inner) return '<'+tag+attrStr+'>'+text+'</'+tag+'>';
        return '<'+tag+attrStr+'>' + (text?'\\n  '+text:'') + '\\n' + inner + '</'+tag+'>';
    }
    const root = document.querySelector(rootSel || 'body') || document.body;
    return walk(root, 0).slice(0, 10000);
})`;

// ── Browser actions ───────────────────────────────────────────────
async function takeScreenshot(view) {
    const image = await view.webContents.capturePage();
    const { width } = image.getSize();
    const resized = width > 1280 ? image.resize({ width: 1280 }) : image;
    return resized.toJPEG(55).toString('base64');
}

async function doClick(view, { x, y, button = 'left' }) {
    view.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
    await sleep(40);
    view.webContents.sendInputEvent({ type: 'mouseUp',   x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
}

async function doClickSelector(view, selector, nth = 0) {
    const result = await view.webContents.executeJavaScript(`
        (function() {
            const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
            const el  = els[${Number(nth) || 0}];
            if (!el) return { ok: false, error: 'Not found: ${selector.replace(/`/g,"'")} (found ' + els.length + ' total)' };
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.focus();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, cancelable:true }));
            el.dispatchEvent(new MouseEvent('click',     { bubbles:true, cancelable:true }));
            return { ok: true, tag: el.tagName, text: (el.textContent||'').trim().slice(0,60), testid: el.getAttribute('data-testid') };
        })()
    `).catch(e => ({ ok: false, error: e.message }));
    return result;
}

async function doTypeIn(view, selector, text, clear = false) {
    await view.webContents.executeJavaScript(`
        (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.focus();
            el.click();
            ${clear ? 'el.value = ""; el.dispatchEvent(new Event("input", {bubbles:true}));' : ''}
            return true;
        })()
    `).catch(() => false);
    await sleep(80);
    for (const char of String(text)) {
        view.webContents.sendInputEvent({ type: 'char', keyCode: char });
        await sleep(15);
    }
}

async function doGetDom(view, selector = 'body') {
    return view.webContents.executeJavaScript(`${DOM_SCRIPT}(${JSON.stringify(selector)})`).catch(e => `Error: ${e.message}`);
}

async function doEvalJs(view, code) {
    try {
        const r = await view.webContents.executeJavaScript(code);
        return { ok: true, result: String(r ?? '').slice(0, 2000) };
    } catch(e) {
        return { ok: false, error: e.message };
    }
}

async function doType(view, text) {
    for (const char of String(text)) {
        view.webContents.sendInputEvent({ type: 'char', keyCode: char });
        await sleep(15);
    }
}

// ── Browser actions ───────────────────────────────────────────────
async function doKey(view, keyCode) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: String(keyCode) });
    await sleep(30);
    view.webContents.sendInputEvent({ type: 'keyUp',   keyCode: String(keyCode) });
}

async function doScroll(view, x, y, deltaY) {
    view.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: -Math.round(deltaY) });
}

// ── Tool executor (shared) ────────────────────────────────────────
async function executeTool(view, toolName, input) {
    switch (toolName) {
        case 'screenshot': {
            const data = await takeScreenshot(view);
            return { screenshot: true, data };
        }
        case 'get_dom': {
            const dom = await doGetDom(view, input?.selector);
            return { dom };
        }
        case 'click_selector': {
            const res = await doClickSelector(view, input.selector, input.nth ?? 0);
            await sleep(300);
            return res;
        }
        case 'type_in': {
            await doTypeIn(view, input.selector, input.text || '', input.clear);
            return { ok: true };
        }
        case 'js': {
            return doEvalJs(view, input.code);
        }
        case 'click':    await doClick(view, input);                            return {};
        case 'type':     await doType(view, input.text || '');                  return {};
        case 'key':      await doKey(view, input.key);                          return {};
        case 'scroll':   await doScroll(view, input.x, input.y, input.deltaY);  return {};
        case 'navigate': await view.webContents.loadURL(input.url);             return {};
        case 'wait':     await sleep(input.ms);                                 return {};
        default:                                                                 return {};
    }
}

// ═══════════════════════════════════════════════════════════════════
// ── Claude (Anthropic) ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

async function callClaude(apiKey, model, messages) {
    const resp = await net.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 4096,
            system:     SYSTEM_PROMPT,
            tools:      TOOLS_CLAUDE,
            messages,
        }),
    });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`Claude API ${resp.status}: ${txt.slice(0, 200)}`);
    }
    return resp.json();
}

async function runAgentClaude(win, getView, task, apiKey, model, signal) {
    const messages = [{ role: 'user', content: task }];
    let step = 0;
    const MAX_STEPS = 30;
    const turnToolHistory = [];
    let loopWarnings = 0;

    while (!signal.aborted) {
        if (++step > MAX_STEPS) {
            emit(win, { type: 'error', text: `Агент зупинено: перевищено ліміт ${MAX_STEPS} кроків. Спробуй переформулювати завдання.` });
            return;
        }
        const view = getView();
        if (!view || view.webContents.isDestroyed()) {
            emit(win, { type: 'error', text: 'BrowserView недоступний' });
            return;
        }

        let response;
        try {
            response = await callClaude(apiKey, model, messages);
        } catch (err) {
            emit(win, { type: 'error', text: err.message });
            return;
        }

        if (signal.aborted) return;

        const { content, stop_reason } = response;
        messages.push({ role: 'assistant', content });

        const toolResults = [];
        let shouldStop = false;
        let stopEvent  = null;

        for (const block of content) {
            if (signal.aborted) break;

            if (block.type === 'text' && block.text) {
                emit(win, { type: 'thought', text: block.text });
            }

            if (block.type === 'tool_use') {
                const { id, name, input } = block;
                emit(win, { type: 'action', tool: name, input });

                if (name === 'done') {
                    shouldStop = true;
                    stopEvent  = { type: 'done', text: input?.text || 'Завдання виконано' };
                    toolResults.push({ type: 'tool_result', tool_use_id: id, content: 'completed' });
                    break;
                }
                if (name === 'fail') {
                    shouldStop = true;
                    stopEvent  = { type: 'error', text: input?.text || 'Завдання не вдалось' };
                    toolResults.push({ type: 'tool_result', tool_use_id: id, content: 'failed' });
                    break;
                }

                try {
                    const result = await executeTool(view, name, input);
                    if (result.screenshot && result.data) {
                        emit(win, { type: 'screenshot', data: result.data });
                        toolResults.push({
                            type:        'tool_result',
                            tool_use_id: id,
                            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.data } }],
                        });
                    } else if (result.dom) {
                        toolResults.push({ type: 'tool_result', tool_use_id: id, content: result.dom });
                    } else {
                        const text = JSON.stringify(result);
                        toolResults.push({ type: 'tool_result', tool_use_id: id, content: text });
                    }
                } catch (err) {
                    toolResults.push({ type: 'tool_result', tool_use_id: id, content: `error: ${err.message}`, is_error: true });
                }
            }
        }

        if (shouldStop) {
            if (!signal.aborted && stopEvent) emit(win, stopEvent);
            return;
        }
        if (signal.aborted) return;

        if (toolResults.length > 0) {
            // ── Loop detection ────────────────────────────────────────
            const toolsThisTurn = content
                .filter(b => b.type === 'tool_use')
                .map(b => b.name);
            const mainTool = toolsThisTurn[0];
            if (mainTool) {
                turnToolHistory.push(mainTool);
                if (turnToolHistory.length > 10) turnToolHistory.shift();
                const last3 = turnToolHistory.slice(-3);
                if (last3.length === 3 && last3.every(t => t === mainTool)) {
                    loopWarnings++;
                    if (loopWarnings >= 3) {
                        emit(win, { type: 'error', text: `Агент зупинено: нескінченний цикл ("${mainTool}" × ${2 + loopWarnings} рази). Спробуй переформулювати.` });
                        return;
                    }
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: content.filter(b => b.type === 'tool_use').slice(-1)[0]?.id || 'warn',
                        content: `⚠️ SYSTEM WARNING: Ти вже ${2 + loopWarnings} рази підряд використовуєш "${mainTool}". ЗАБОРОНЕНО. Негайно спробуй ІНШИЙ інструмент або виклич fail.`,
                    });
                } else if (mainTool !== (turnToolHistory[turnToolHistory.length - 2] || '')) {
                    loopWarnings = 0;
                }
            }
            // ─────────────────────────────────────────────────────────
            messages.push({ role: 'user', content: toolResults });
        } else if (stop_reason === 'end_turn') {
            emit(win, { type: 'done', text: 'Агент завершив роботу' });
            return;
        } else {
            emit(win, { type: 'done', text: 'Агент завершив роботу' });
            return;
        }
    }

    if (signal.aborted) emit(win, { type: 'stopped' });
}

// ═══════════════════════════════════════════════════════════════════
// ── Gemini (Google) ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Returns { message, retryable }
function _parseGemini429(txt, modelId) {
    try {
        const d = JSON.parse(txt);
        const msg = (d.error?.message || '').toLowerCase();
        if (msg.includes('day') || msg.includes('daily') || msg.includes('exceeded your current quota')) {
            return {
                message: `Gemini: денний ліміт вичерпано для "${modelId}". Безкоштовно — 1 500 запитів/день. Спробуйте завтра або оберіть іншу модель.`,
                retryable: false,
            };
        }
        if (msg.includes('minute') || msg.includes('per-minute') || msg.includes('rate')) {
            return { message: `Gemini: ліміт запитів/хвилину. Автоматичний retry...`, retryable: true };
        }
    } catch {}
    return { message: `Gemini: ліміт запитів (429). Зачекайте та спробуйте знову.`, retryable: true };
}

async function callGemini(apiKey, model, contents, signal = null, onWait = null) {
    const modelId = model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const bodyStr = JSON.stringify({
        contents,
        tools: TOOLS_GEMINI,
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tool_config: { function_calling_config: { mode: 'AUTO' } },
        generation_config: { max_output_tokens: 4096, temperature: 0 },
    });

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error('Скасовано');

        const resp = await net.fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: bodyStr,
        });

        if (resp.ok) return resp.json();

        const txt = await resp.text().catch(() => '');

        if (resp.status === 429) {
            const parsed = _parseGemini429(txt, modelId);
            if (parsed.retryable && attempt < MAX_RETRIES) {
                const retryAfter = parseInt(resp.headers?.get?.('retry-after') || '0', 10);
                const waitSec    = retryAfter > 0 ? retryAfter : Math.min(20 * (attempt + 1), 60);
                if (onWait) onWait(waitSec, attempt + 2, MAX_RETRIES + 1);
                await sleep(waitSec * 1000);
                continue;
            }
            throw new Error(parsed.message);
        }
        if (resp.status === 400) throw new Error(`Gemini: невірний запит (можливо модель "${modelId}" не підтримує function calling). Оберіть gemini-2.0-flash.`);
        if (resp.status === 401 || resp.status === 403) throw new Error('Gemini: невірний або прострочений API ключ. Перевірте на aistudio.google.com/apikey');
        throw new Error(`Gemini API ${resp.status}: ${txt.slice(0, 300)}`);
    }
}

async function runAgentGemini(win, getView, task, apiKey, model, signal) {
    // Gemini conversation history
    const contents = [{ role: 'user', parts: [{ text: task }] }];
    let step = 0;
    const MAX_STEPS = 30;
    const turnToolHistory = []; // first tool name used each turn (for loop detection)
    let loopWarnings = 0;

    while (!signal.aborted) {
        if (++step > MAX_STEPS) {
            emit(win, { type: 'error', text: `Агент зупинено: перевищено ліміт ${MAX_STEPS} кроків. Спробуй переформулювати завдання.` });
            return;
        }
        const view = getView();
        if (!view || view.webContents.isDestroyed()) {
            emit(win, { type: 'error', text: 'BrowserView недоступний' });
            return;
        }

        let response;
        try {
            response = await callGemini(apiKey, model, contents, signal, (waitSec, attempt, total) => {
                emit(win, { type: 'thought', text: `⏳ Rate limit — чекаємо ${waitSec}с (спроба ${attempt}/${total})...` });
            });
        } catch (err) {
            emit(win, { type: 'error', text: err.message });
            return;
        }

        if (signal.aborted) return;

        const candidate = response.candidates?.[0];
        if (!candidate) {
            emit(win, { type: 'error', text: 'Gemini: порожня відповідь' });
            return;
        }

        const modelParts = candidate.content?.parts || [];
        // Append model turn to history
        contents.push({ role: 'model', parts: modelParts });

        const funcResponses = [];
        let shouldStop = false;
        let stopEvent  = null;

        for (const part of modelParts) {
            if (signal.aborted) break;

            // Text / thought
            if (part.text) {
                emit(win, { type: 'thought', text: part.text });
            }

            // Function call
            if (part.functionCall) {
                const { name, args } = part.functionCall;
                emit(win, { type: 'action', tool: name, input: args });

                if (name === 'done') {
                    shouldStop = true;
                    stopEvent  = { type: 'done', text: args?.text || 'Завдання виконано' };
                    funcResponses.push({
                        functionResponse: { name, response: { result: 'completed' } },
                    });
                    break;
                }
                if (name === 'fail') {
                    shouldStop = true;
                    stopEvent  = { type: 'error', text: args?.text || 'Завдання не вдалось' };
                    funcResponses.push({
                        functionResponse: { name, response: { result: 'failed' } },
                    });
                    break;
                }

                try {
                    const result = await executeTool(view, name, args);
                    if (result.screenshot && result.data) {
                        emit(win, { type: 'screenshot', data: result.data });
                        funcResponses.push({ functionResponse: { name, response: { result: 'screenshot captured' } } });
                        funcResponses.push({ inlineData: { mimeType: 'image/jpeg', data: result.data } });
                    } else if (result.dom) {
                        funcResponses.push({ functionResponse: { name, response: { dom: result.dom } } });
                    } else {
                        funcResponses.push({ functionResponse: { name, response: result } });
                    }
                } catch (err) {
                    funcResponses.push({
                        functionResponse: { name, response: { error: err.message } },
                    });
                }
            }
        }

        if (shouldStop) {
            if (!signal.aborted && stopEvent) emit(win, stopEvent);
            return;
        }
        if (signal.aborted) return;

        const finishReason = candidate.finishReason;

        if (funcResponses.length > 0) {
            // ── Loop detection ────────────────────────────────────────
            const toolsThisTurn = modelParts
                .filter(p => p.functionCall)
                .map(p => p.functionCall.name);
            const mainTool = toolsThisTurn[0];
            if (mainTool) {
                turnToolHistory.push(mainTool);
                if (turnToolHistory.length > 10) turnToolHistory.shift();
                // Check last 3 turns: if all same tool → loop
                const last3 = turnToolHistory.slice(-3);
                if (last3.length === 3 && last3.every(t => t === mainTool)) {
                    loopWarnings++;
                    if (loopWarnings >= 3) {
                        emit(win, { type: 'error', text: `Агент зупинено: нескінченний цикл ("${mainTool}" × ${2 + loopWarnings} рази). Спробуй переформулювати.` });
                        return;
                    }
                    funcResponses.push({
                        text: `⚠️ SYSTEM WARNING: Ти вже ${2 + loopWarnings} рази підряд використовуєш "${mainTool}". Це ЗАБОРОНЕНО. Негайно спробуй ІНШИЙ інструмент (наприклад js() якщо click_selector не працює, або fail якщо задача неможлива).`,
                    });
                } else if (mainTool !== (turnToolHistory[turnToolHistory.length - 2] || '')) {
                    loopWarnings = 0; // different tool — reset
                }
            }
            // ─────────────────────────────────────────────────────────
            contents.push({ role: 'user', parts: funcResponses });
        } else if (finishReason === 'STOP' || finishReason === 'MAX_TOKENS') {
            emit(win, { type: 'done', text: 'Агент завершив роботу' });
            return;
        } else {
            emit(win, { type: 'done', text: 'Агент завершив роботу' });
            return;
        }
    }

    if (signal.aborted) emit(win, { type: 'stopped' });
}

// ═══════════════════════════════════════════════════════════════════
// ── Fetch available Gemini models ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Models that work with the agent (need generateContent + function calling + vision)
// Ordered by recommendation for agent use
const AGENT_MODEL_PRIORITY = [
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-pro',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
];

// Patterns in model IDs that indicate models NOT suitable for the agent
const EXCLUDED_PATTERNS = [
    'embedding', 'embed',
    '-vision',          // old vision-only models
    'aqa',
    'text-bison', 'chat-bison', 'code-bison',
    'imagen',
    'text-embedding',
    'tts',
];

async function fetchGeminiModels(apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`;
    const resp = await net.fetch(url);
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        if (resp.status === 429) throw new Error('Gemini: ліміт запитів. Зачекайте хвилину і спробуйте знову.');
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
            throw new Error('Невірний API ключ Gemini. Перевірте ключ на aistudio.google.com/apikey');
        }
        throw new Error(`Gemini API ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();

    const filtered = (data.models || []).filter(m => {
        const id = (m.name || '').replace('models/', '');
        // Must support generateContent
        if (!m.supportedGenerationMethods?.includes('generateContent')) return false;
        // Must have "gemini" in name (excludes embedding, aqa, imagen etc.)
        if (!id.includes('gemini')) return false;
        // Exclude known non-agent patterns
        if (EXCLUDED_PATTERNS.some(p => id.includes(p))) return false;
        return true;
    });

    // Sort: priority models first, then alphabetically
    filtered.sort((a, b) => {
        const aId = a.name.replace('models/', '');
        const bId = b.name.replace('models/', '');
        const aP  = AGENT_MODEL_PRIORITY.findIndex(p => aId.startsWith(p));
        const bP  = AGENT_MODEL_PRIORITY.findIndex(p => bId.startsWith(p));
        if (aP === -1 && bP === -1) return aId.localeCompare(bId);
        if (aP === -1) return 1;
        if (bP === -1) return -1;
        return aP - bP;
    });

    return filtered.map(m => {
        const id = m.name.replace('models/', '');
        const isFree = id.includes('flash'); // flash models have free tier
        return {
            id,
            displayName: m.displayName || id,
            description: m.description || '',
            inputTokenLimit:  m.inputTokenLimit,
            outputTokenLimit: m.outputTokenLimit,
            free: isFree,
        };
    });
}

// ═══════════════════════════════════════════════════════════════════
// ── Public API ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

exports.startAgent = function startAgent(win, getView, task, apiKey, model, provider = 'anthropic') {
    if (activeAgents.has(win.id)) {
        activeAgents.get(win.id).abort();
    }

    const ctrl = new AbortController();
    activeAgents.set(win.id, ctrl);

    const runner = provider === 'gemini'
        ? runAgentGemini(win, getView, task, apiKey, model, ctrl.signal)
        : runAgentClaude(win, getView, task, apiKey, model, ctrl.signal);

    runner
        .catch(err => emit(win, { type: 'error', text: err.message }))
        .finally(() => {
            if (activeAgents.get(win.id) === ctrl) activeAgents.delete(win.id);
        });
};

exports.stopAgent = function stopAgent(win) {
    const ctrl = activeAgents.get(win.id);
    if (ctrl) {
        ctrl.abort();
        activeAgents.delete(win.id);
    }
};

exports.fetchGeminiModels = fetchGeminiModels;
