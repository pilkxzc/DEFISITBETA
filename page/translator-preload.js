'use strict';
// Runs in every webContents of the profile session via session.setPreloads().
// Only activates for regular http/https pages — skips extension pages, about:, etc.

if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

const { ipcRenderer } = require('electron');

// Bridge: page scripts (injected by main process) can call this too
window._defisTranslate = (text, sl, tl) =>
    ipcRenderer.invoke('translate', { text, sl, tl });

const cfg = ipcRenderer.sendSync('get-translator-config') || {};
if (!cfg.enabled) return;

// ── Wait for DOM then build UI ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => buildTranslatorUI(cfg));

function buildTranslatorUI(cfg) {
    // ── Popup element ─────────────────────────────────────────────────────────
    const popup = document.createElement('div');
    popup.id = '__defis_tr_popup';
    popup.style.cssText =
        'position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #45475a;' +
        'border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.7);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;' +
        'color:#cdd6f4;width:380px;max-width:calc(100vw - 24px);' +
        'max-height:min(520px,80vh);display:none;pointer-events:auto;' +
        'flex-direction:column;overflow:hidden;line-height:1.6;';
    popup.innerHTML =
        /* header — fixed, never scrolls */
        '<div style="display:flex;justify-content:space-between;align-items:center;' +
             'padding:10px 14px 8px;border-bottom:1px solid #313244;flex-shrink:0;">' +
          '<span id="__dt_langs" style="font-size:11px;color:#7f849c;letter-spacing:.5px;font-weight:600;"></span>' +
          '<button id="__dt_close" style="background:none;border:none;color:#7f849c;cursor:pointer;' +
          'font-size:20px;line-height:1;padding:0 2px;margin-left:8px;flex-shrink:0;" title="Закрити">×</button>' +
        '</div>' +
        /* scrollable body */
        '<div id="__dt_body" style="flex:1;overflow-y:auto;padding:10px 14px;min-height:40px;' +
             'scrollbar-width:thin;scrollbar-color:#45475a #1e1e2e;">' +
          '<div id="__dt_loading" style="color:#7f849c;font-size:12px;display:none;">Перекладаю…</div>' +
          '<div id="__dt_text" style="word-break:break-word;white-space:pre-wrap;display:none;' +
               'user-select:text;cursor:text;"></div>' +
        '</div>' +
        /* footer — fixed, never scrolls */
        '<div id="__dt_btns" style="display:none;gap:6px;padding:8px 14px 10px;' +
             'border-top:1px solid #313244;flex-shrink:0;">' +
          '<button id="__dt_copy"    style="flex:1;padding:6px 10px;background:#313244;border:none;' +
          'border-radius:7px;color:#cdd6f4;cursor:pointer;font-size:12px;">Копіювати</button>' +
          '<button id="__dt_replace" style="flex:1;padding:6px 10px;background:#89b4fa;border:none;' +
          'border-radius:7px;color:#1e1e2e;cursor:pointer;font-size:12px;font-weight:600;' +
          'display:none;">Замінити</button>' +
        '</div>';

    document.body.appendChild(popup);

    const $  = (id) => popup.querySelector('#' + id);
    const el = { langs: $('__dt_langs'), loading: $('__dt_loading'), text: $('__dt_text'),
                  btns: $('__dt_btns'), copy: $('__dt_copy'), replace: $('__dt_replace'),
                  close: $('__dt_close'), body: $('__dt_body') };

    const NAMES = { auto:'Auto',uk:'UK',en:'EN',de:'DE',fr:'FR',es:'ES',it:'IT',pl:'PL',
                    pt:'PT',zh:'ZH',ja:'JA',ko:'KO',ar:'AR',ru:'RU',tr:'TR',nl:'NL',
                    sv:'SV',cs:'CS',he:'HE',hi:'HI',id:'ID',vi:'VI' };

    let lastTranslation = '';
    let editableEl      = null;
    let savedRange      = null;
    let savedStart      = 0;   // selectionStart saved before focus is lost
    let savedEnd        = 0;   // selectionEnd   saved before focus is lost

    // ── Smart translate: auto-flip when detected lang === target lang ──────────
    async function smartTranslate(text, sl, tl) {
        const result = await window._defisTranslate(text, sl, tl).catch(() => null);
        if (!result?.translation) return result;

        const detected = result.detectedLang || sl;
        // If what we detected is the same as the target, flip the target
        if (detected && detected !== 'auto' && detected === tl) {
            const flipTl = tl === 'en' ? 'uk' : 'en';
            const flipped = await window._defisTranslate(text, sl, flipTl).catch(() => null);
            if (flipped?.translation) {
                flipped.detectedLang  = flipped.detectedLang || detected;
                flipped._effectiveTl  = flipTl;
                return flipped;
            }
        }
        result._effectiveTl = tl;
        return result;
    }

    // ── Langs label helper ────────────────────────────────────────────────────
    function setLangsLabel(result, sl, tl) {
        const from = result.detectedLang || (sl === 'auto' ? '?' : sl);
        const to   = result._effectiveTl || tl;
        el.langs.textContent = (NAMES[from] || from.toUpperCase()) + ' → ' + (NAMES[to] || to.toUpperCase());
    }

    // ── Position popup near cursor, always fully visible ─────────────────────
    function showAt(clientX, clientY) {
        popup.style.left    = '0';
        popup.style.top     = '0';
        popup.style.display = 'flex';
        requestAnimationFrame(() => {
            const pw = popup.offsetWidth, ph = popup.offsetHeight;
            const vw = window.innerWidth,  vh = window.innerHeight;
            const margin = 10;
            let x = clientX - pw / 2;
            let y = clientY - ph - 14;       // try above cursor first
            // Clamp horizontally
            if (x < margin) x = margin;
            if (x + pw > vw - margin) x = vw - pw - margin;
            // If not enough space above → show below cursor
            if (y < margin) y = clientY + 22;
            // If still doesn't fit below either → anchor to bottom edge
            if (y + ph > vh - margin) y = vh - ph - margin;
            if (y < margin) y = margin;      // last resort: top edge
            popup.style.left = x + 'px';
            popup.style.top  = y + 'px';
        });
    }

    function hide() {
        popup.style.display = 'none';
        editableEl = null;
        savedRange = null;
    }

    function resetBody() {
        el.loading.style.display = 'none';
        el.text.style.display    = 'none';
        el.btns.style.display    = 'none';
        el.body.scrollTop        = 0;
    }

    // ── Button handlers ───────────────────────────────────────────────────────
    el.close.addEventListener('click', hide);

    el.copy.addEventListener('click', () => {
        if (lastTranslation) navigator.clipboard?.writeText(lastTranslation).catch(() => {});
        hide();
    });

    // ── Shared replace logic ──────────────────────────────────────────────────
    // selectionStart/End are read NOW (on mouseup), stored in savedStart/savedEnd,
    // so they remain valid even after the input loses focus when user clicks popup.
    function doReplace() {
        if (!lastTranslation || !editableEl) return;
        if (editableEl.tagName === 'INPUT' || editableEl.tagName === 'TEXTAREA') {
            const s = savedStart, e2 = savedEnd;
            editableEl.focus();
            editableEl.value =
                editableEl.value.slice(0, s) + lastTranslation + editableEl.value.slice(e2);
            editableEl.selectionStart = editableEl.selectionEnd = s + lastTranslation.length;
            editableEl.dispatchEvent(new Event('input',  { bubbles: true }));
            editableEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (editableEl.isContentEditable) {
            const sel = window.getSelection();
            if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
            if (sel.rangeCount) {
                sel.deleteFromDocument();
                const node = document.createTextNode(lastTranslation);
                sel.getRangeAt(0).insertNode(node);
                sel.collapseToEnd();
                editableEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        hide();
    }

    el.replace.addEventListener('click', doReplace);

    document.addEventListener('mousedown', (e) => {
        if (!popup.contains(e.target)) hide();
    });

    // ── Keyboard shortcut handler ─────────────────────────────────────────────
    function matchesShortcut(e) {
        const sc = cfg.shortcut;
        if (!sc) return false;
        const parts = sc.split('+');
        const key   = parts[parts.length - 1];
        return e.ctrlKey  === parts.includes('Ctrl')
            && e.altKey   === parts.includes('Alt')
            && e.shiftKey === parts.includes('Shift')
            && e.metaKey  === parts.includes('Meta')
            && e.key.toUpperCase() === key.toUpperCase();
    }

    document.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') { hide(); return; }
        if (!matchesShortcut(e)) return;
        const sel  = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2 || text.length > 5000) return;
        e.preventDefault();

        editableEl = findEditable(sel.anchorNode);
        // Save selection indices NOW, before any focus change
        if (editableEl && (editableEl.tagName === 'INPUT' || editableEl.tagName === 'TEXTAREA')) {
            savedStart = editableEl.selectionStart;
            savedEnd   = editableEl.selectionEnd;
        }
        try { savedRange = sel.getRangeAt(0).cloneRange(); } catch {}

        const sl = cfg.sourceLang || 'auto';
        const tl = cfg.targetLang || 'uk';
        const result = await smartTranslate(text, sl, tl);
        if (!result?.translation) return;
        lastTranslation = result.translation;

        if (editableEl) {
            doReplace();
        } else {
            const range = sel.getRangeAt(0);
            const rect  = range.getBoundingClientRect();
            setLangsLabel(result, sl, tl);
            resetBody();
            el.text.textContent      = result.translation;
            el.text.style.display    = 'block';
            el.btns.style.display    = 'flex';
            el.replace.style.display = 'none';
            showAt(rect.left + rect.width / 2, rect.top);
        }
    });

    // ── Helper: find editable ancestor ───────────────────────────────────────
    function findEditable(node) {
        let n = node?.nodeType === 3 ? node.parentElement : node;
        while (n) {
            const tag = n.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return n;
            if (n.isContentEditable && n !== document.body) return n;
            n = n.parentElement;
        }
        return null;
    }

    // ── Main selection listener ───────────────────────────────────────────────
    let debounce = null;
    document.addEventListener('mouseup', (e) => {
        if (popup.contains(e.target)) return;
        const cursorX = e.clientX, cursorY = e.clientY;
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
            const sel  = window.getSelection();
            const text = sel?.toString().trim();
            if (!text || text.length < 2 || text.length > 5000) { hide(); return; }

            // Save editable context NOW before focus is lost
            editableEl = findEditable(sel.anchorNode);
            if (editableEl && (editableEl.tagName === 'INPUT' || editableEl.tagName === 'TEXTAREA')) {
                savedStart = editableEl.selectionStart;
                savedEnd   = editableEl.selectionEnd;
            }
            try { savedRange = sel.getRangeAt(0).cloneRange(); } catch {}

            const sl = cfg.sourceLang || 'auto';
            const tl = cfg.targetLang || 'uk';
            el.langs.textContent = (NAMES[sl] || sl.toUpperCase()) + ' → ' + (NAMES[tl] || tl.toUpperCase());
            resetBody();
            el.loading.style.display = 'block';
            showAt(cursorX, cursorY);

            const result = await smartTranslate(text, sl, tl);
            resetBody();

            if (result?.translation) {
                lastTranslation = result.translation;
                el.text.textContent      = result.translation;
                el.text.style.display    = 'block';
                el.btns.style.display    = 'flex';
                el.replace.style.display = editableEl ? 'block' : 'none';
                setLangsLabel(result, sl, tl);
            } else {
                el.text.textContent   = 'Помилка перекладу';
                el.text.style.display = 'block';
            }
            // Re-position now that content size is known
            showAt(cursorX, cursorY);
        }, 350);
    });
}
