// ==UserScript==
// @name         Notion to Markdown
// @namespace    local.notion-to-markdown
// @version      1.1.0
// @description  Collect the current Notion page as it scrolls and download it locally as Markdown, preserving headings, nested lists, tables, and inline code.
// @description:zh-CN 自动滚动收集当前 Notion 页面的正文，在浏览器本地下载 Markdown，保留标题、嵌套列表、表格和行内代码。
// @match        https://app.notion.com/*
// @match        https://www.notion.com/*
// @match        https://notion.so/*
// @match        https://www.notion.so/*
// @match        https://*.notion.site/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js
// @run-at       document-idle
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    const bodySelector = '.notion-page-content';
    const tableSelector = 'table, [role="table"], .notion-table-block';
    const rowSelector = 'tr, [role="row"], .notion-table-row, .notion-table-row-block';
    const cellSelector = 'td, th, [role="cell"], [role="rowheader"], [role="columnheader"], .notion-table-cell';
    const inlineBreak = '\uE000';
    const hiddenSelector = 'script, style, template, [hidden], [aria-hidden="true"], [data-notion-md-export]';
    const virtualSlotSelector = '[data-virtual-item-slot]';
    const listBlockSelector = '.notion-bulleted_list-block, .notion-numbered_list-block';
    const headingLevels = {
        'notion-header-block': 1,
        'notion-sub_header-block': 2,
        'notion-sub_sub_header-block': 3,
        'notion-header_4-block': 4,
        'notion-header_5-block': 5,
        'notion-header_6-block': 6,
    };

    function findPageBody() {
        const visible = [...document.querySelectorAll(bodySelector)].filter(element =>
            element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
        const dialog = visible.findLast(element => element.closest('[role="dialog"]'));
        return dialog || visible.find(element => !element.parentElement?.closest(bodySelector));
    }

    function normalizeRichText(root) {
        for (const inline of root.querySelectorAll('.notion-inline-code, .notion-inline-code-container')) {
            if (inline.closest('code')) continue;
            const existing = inline.querySelector('code');
            if (existing) {
                inline.replaceWith(...inline.childNodes);
            } else {
                const code = document.createElement('code');
                code.textContent = inline.textContent;
                inline.replaceWith(code);
            }
        }
        for (const span of root.querySelectorAll('span')) {
            const tags = [];
            const weight = span.style.fontWeight;
            if ((weight === 'bold' || Number(weight) >= 600) && !span.closest('b, strong, code')) tags.push('strong');
            if (span.style.fontStyle === 'italic' && !span.closest('i, em, code')) tags.push('em');
            let target = span;
            for (const tag of tags) {
                const wrapper = document.createElement(tag);
                wrapper.append(...target.childNodes);
                target.append(wrapper);
                target = wrapper;
            }
        }
    }

    function preserveTextBreaks(root) {
        for (const leaf of root.querySelectorAll('[data-content-editable-leaf]')) {
            if (leaf.closest('pre, code')) continue;
            const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
            const lines = [];
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.data.includes('\n') && !node.parentElement.closest('code, .notion-inline-code-container, .notion-inline-code')) {
                    lines.push(node);
                }
            }
            for (const node of lines) {
                node.replaceWith(...node.data.split('\n').flatMap((line, index) =>
                    index ? [document.createElement('br'), line] : [line]));
            }
        }
    }

    function normalizeBlockStructure(root) {
        for (const divider of root.querySelectorAll('.notion-divider-block')) {
            divider.replaceWith(document.createElement('hr'));
        }
        for (const block of root.querySelectorAll('[data-block-id]')) {
            const level = [...block.classList].map(name => headingLevels[name]).find(Number.isInteger);
            if (!level) continue;
            const heading = block.querySelector('h1, h2, h3, h4, h5, h6');
            if (!heading || heading.closest('[data-block-id]') !== block || heading.tagName === 'H' + level) continue;
            const replacement = document.createElement('h' + level);
            replacement.append(...heading.childNodes);
            heading.replaceWith(replacement);
        }

        for (const block of root.querySelectorAll(listBlockSelector)) {
            if (!root.contains(block)) continue;
            const leaf = block.querySelector('[data-content-editable-leaf]');
            if (!leaf || leaf.closest(listBlockSelector) !== block) {
                if (!block.textContent.trim() && !block.querySelector('img, video, iframe')) block.remove();
                continue;
            }
            const children = [...block.querySelectorAll('[data-block-id]')].filter(child =>
                !leaf.contains(child) && child.dataset.blockId !== block.dataset.blockId &&
                child.parentElement.closest('[data-block-id]') === block);
            const item = document.createElement('li');
            item.append(...leaf.childNodes, ...children);

            const ordered = block.matches('.notion-numbered_list-block');
            const tag = ordered ? 'OL' : 'UL';
            let list = block.previousElementSibling;
            if (list?.tagName !== tag || !list.hasAttribute('data-notion-md-list')) {
                list = document.createElement(tag);
                list.setAttribute('data-notion-md-list', '');
                const number = Number(leaf.getAttribute('aria-roledescription')?.match(/\d+$/)?.[0]);
                if (ordered && number > 1) list.start = number;
                block.before(list);
            }
            block.remove();
            list.append(item);
        }
    }

    function normalizeCodeBlocks(source, clone) {
        const original = source.querySelectorAll('.notion-code-block');
        const copies = clone.querySelectorAll('.notion-code-block');
        original.forEach((block, index) => {
            if (block.querySelector('pre > code')) return;
            const editor = block.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], pre');
            if (!editor) return;
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = editor.innerText;
            pre.append(code);
            copies[index].replaceWith(pre);
        });
    }

    function normalizeLinks(root) {
        for (const element of root.querySelectorAll('a[href], img[src], img[data-src]')) {
            const attribute = element.tagName === 'A' ? 'href' : 'src';
            const value = element.getAttribute(attribute) || element.getAttribute('data-src');
            if (!value) continue;
            try {
                const url = new URL(value, location.href);
                if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
                    element.setAttribute(attribute, url.href);
                } else if (!(element.tagName === 'IMG' && url.protocol === 'data:' && /^data:image\//i.test(value))) {
                    element.removeAttribute(attribute);
                }
            } catch {
                element.removeAttribute(attribute);
            }
        }
    }

    function normalizeFileReferences(root) {
        for (const block of root.querySelectorAll('.notion-file-block, .notion-embed-block')) {
            const attachment = block.querySelector('iframe[src], a[download]');
            if (!attachment) continue;
            let filename = attachment.getAttribute('download');
            if (!filename) {
                try {
                    const url = new URL(attachment.getAttribute('src') || attachment.getAttribute('href'), location.href);
                    const path = decodeURIComponent(url.pathname.split('/').at(-1));
                    filename = /^attachment:[\da-f-]+:(.+)$/i.exec(path)?.[1];
                } catch {
                    continue;
                }
            }
            if (!filename) continue;
            const reference = document.createElement('p');
            reference.setAttribute('data-notion-md-file', '');
            reference.textContent = filename;
            block.replaceWith(reference);
        }
    }

    function createConverter() {
        const converter = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-',
            emDelimiter: '*',
            hr: '---',
        });
        converter.addRule('numberedHeading', {
            filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            replacement: (content, node) =>
                '\n\n' + '#'.repeat(Number(node.tagName[1])) + ' ' + content.replace(/^(\d+)\\\./, '$1.') + '\n\n',
        });
        converter.addRule('attachmentName', {
            filter: node => node.hasAttribute('data-notion-md-file'),
            replacement: (_, node) => '\n\n[' + node.textContent.replace(/([\\\[\]])/g, '\\$1') + ']\n\n',
        });
        converter.addRule('adjacentEmphasis', {
            filter: node => node.matches('b, strong, i, em') &&
                (/\S$/.test(node.previousSibling?.textContent || '') ||
                    /^\S/.test(node.nextSibling?.textContent || '')),
            replacement: (content, node) => {
                // Inline HTML keeps emphasis next to CJK text and punctuation unambiguous.
                const tag = node.matches('b, strong') ? 'strong' : 'em';
                return '<' + tag + '>' + content + '</' + tag + '>';
            },
        });
        converter.addRule('notionTable', {
            filter: node => node.matches(tableSelector),
            replacement: (content, table) => {
                const innerTable = table.matches('table') ? table : table.querySelector('table, [role="table"]') || table;
                const rowNodes = [...innerTable.querySelectorAll(rowSelector)].filter(row => {
                    const scope = row.closest('table, [role="table"]') || row.closest('.notion-table-block');
                    return scope === innerTable && !row.parentElement?.closest(rowSelector);
                });
                const cellsByRow = rowNodes.map(row => [...row.querySelectorAll(cellSelector)].filter(cell =>
                    cell.closest(rowSelector) === row && !cell.parentElement?.closest(cellSelector)));
                if (!cellsByRow.length || cellsByRow.some(cells => !cells.length)) {
                    return '\n\n' + content + '\n\n';
                }

                const rows = cellsByRow.map(cells => cells.flatMap(cell => {
                    // GFM has no merged cells. Keep the text once and reserve the covered columns.
                    const value = converter.turndown(cell.innerHTML.replace(/<br\s*\/?>/gi, inlineBreak))
                        .replace(new RegExp(inlineBreak, 'g'), '<br>')
                        .replace(/[ \t]*\n+[ \t]*/g, '<br>')
                        .replace(/(\\*)\|/g, (_, slashes) => slashes + (slashes.length % 2 ? '|' : '\\|'));
                    return [value, ...Array(Math.max(1, cell.colSpan || 1) - 1).fill('')];
                }));
                const width = Math.max(...rows.map(row => row.length));
                const line = row => '| ' + Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ') + ' |';
                // Notion may render header cells as ordinary td elements.
                const [firstRow, ...dataRows] = rows;
                return '\n\n' + [
                    line(firstRow),
                    line(Array(width).fill('---')),
                    ...dataRows.map(line),
                ].join('\n') + '\n\n';
            },
        });
        return converter;
    }

    function cloneContent(source) {
        const copy = source.cloneNode(true);
        normalizeCodeBlocks(source, copy);
        return copy;
    }

    async function loadPage(source) {
        let scroller = source.closest('.notion-scroller');
        if (!scroller) {
            for (let element = source; element; element = element.parentElement) {
                if (/auto|scroll/.test(getComputedStyle(element).overflowY)) {
                    scroller = element;
                    break;
                }
            }
        }
        scroller ||= document.scrollingElement;
        const initialTop = scroller.scrollTop;
        const initialUrl = location.href;
        const scrollTo = top => scroller.scrollTo({ top, behavior: 'instant' });
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const deadline = Date.now() + 120000;
        const blocks = new Map();
        const readSlots = () => [...source.querySelectorAll(virtualSlotSelector + ' > [data-index]')].filter(slot =>
            !slot.parentElement.parentElement?.closest(virtualSlotSelector));

        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                scrollTo(0);
                let reachedStart = false;
                let settledAt = 0;
                let lastBottom = 0;
                let lastSize = 0;
                while (Date.now() < deadline) {
                    await wait(150);
                    if (!source.isConnected || location.href !== initialUrl) throw new Error('Notion 页面已切换，请重新导出。');
                    const slots = readSlots();
                    if (!reachedStart) {
                        // Measuring previously unmounted blocks can move Notion away from the requested top.
                        reachedStart = scroller.scrollTop <= 2 && (!slots.length || slots[0].dataset.index === '0');
                        if (!reachedStart) {
                            scrollTo(0);
                            continue;
                        }
                    }
                    for (const slot of slots) {
                        if (!slot.children.length) continue;
                        const index = Number(slot.dataset.index);
                        const saved = blocks.get(index);
                        if (saved?.source !== slot || saved.html !== slot.innerHTML) {
                            blocks.set(index, { source: slot, html: slot.innerHTML, copy: cloneContent(slot) });
                        }
                    }

                    const bottom = scroller.scrollHeight - scroller.clientHeight;
                    if (scroller.scrollTop < bottom - 2) {
                        scrollTo(scroller.scrollTop + Math.max(1, Math.floor(scroller.clientHeight * 0.85)));
                        settledAt = 0;
                        continue;
                    }
                    if (bottom !== lastBottom || blocks.size !== lastSize || source.querySelector('[aria-busy="true"]')) {
                        settledAt = 0;
                        lastBottom = bottom;
                        lastSize = blocks.size;
                    }
                    settledAt ||= Date.now();
                    if (Date.now() - settledAt < 750) continue;
                    if (!blocks.size && !slots.length) return cloneContent(source);

                    const indices = [...blocks.keys()].sort((a, b) => a - b);
                    const lastSlot = Number(slots.at(-1)?.dataset.index);
                    if (indices.every((index, offset) => index === offset) && indices.at(-1) === lastSlot) {
                        const copy = source.cloneNode(false);
                        for (const index of indices) copy.append(...blocks.get(index).copy.childNodes);
                        return copy;
                    }
                    break;
                }
            }
            throw new Error('未能完整加载 Notion 正文，已取消下载。请重试。');
        } finally {
            if (scroller.isConnected && location.href === initialUrl) scrollTo(initialTop);
        }
    }

    async function downloadMarkdown() {
        const source = findPageBody();
        if (!source) throw new Error('找不到页面正文，请等 Notion 页面加载完成后再试。');

        const copy = await loadPage(source);
        copy.querySelectorAll(hiddenSelector).forEach(node => node.remove());
        normalizeFileReferences(copy);
        normalizeRichText(copy);
        preserveTextBreaks(copy);
        normalizeBlockStructure(copy);
        normalizeLinks(copy);
        const markdown = createConverter().turndown(copy);
        if (!markdown.trim()) throw new Error('页面正文为空。');

        const title = document.title.replace(/\s*(?:\||[–—-])\s*Notion\s*$/i, '').trim() || 'Notion';
        const filename = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'Notion';
        const sourceUrl = new URL(location.href);
        sourceUrl.hash = '';
        sourceUrl.search = '';
        const text = `# ${title.replace(/([\\`*_\[\]<>])/g, '\\$1')}\n\n来源：<${sourceUrl.href}>\n\n${markdown.trim()}\n`;
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename + '.md';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    GM_addStyle(`
        #notion-md-export {
            position: fixed; right: 24px; bottom: 24px; z-index: 10000;
            border: 1px solid #51586b; border-radius: 24px; padding: 11px 16px;
            background: #242939; color: #fff; box-shadow: 0 3px 13px #0004;
            font: 600 13px system-ui, sans-serif; cursor: pointer;
        }
        #notion-md-export:hover { background: #363e55; }
        #notion-md-export:disabled { cursor: wait; opacity: 0.75; }
        #notion-md-export:focus-visible { outline: 2px solid #7599ff; outline-offset: 3px; }
        #notion-md-status {
            position: fixed; right: 24px; bottom: 76px; z-index: 10000;
            max-width: min(350px, 85vw); border-radius: 8px; padding: 9px 12px;
            background: #242939; color: #fff; font: 13px system-ui, sans-serif;
        }
    `);

    const button = document.createElement('button');
    button.id = 'notion-md-export';
    button.type = 'button';
    button.textContent = '下载 Markdown';
    const status = document.createElement('div');
    status.id = 'notion-md-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    let clearStatus;
    button.addEventListener('click', async () => {
        if (button.disabled) return;
        clearTimeout(clearStatus);
        button.disabled = true;
        status.textContent = '正在加载整页正文…';
        status.hidden = false;
        try {
            await downloadMarkdown();
            status.textContent = '已请求下载 Markdown';
        } catch (error) {
            status.textContent = error.message || 'Markdown 导出失败。';
        } finally {
            button.disabled = false;
            clearStatus = setTimeout(() => { status.hidden = true; }, 4200);
        }
    });

    function mountButton() {
        if (!button.isConnected && findPageBody()) document.body.append(button, status);
        if (button.isConnected && !findPageBody()) {
            button.remove();
            status.remove();
        }
    }

    // Notion can swap pages without reloading the tab.
    let frame = 0;
    new MutationObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            mountButton();
        });
    }).observe(document.body, { childList: true, subtree: true });
    mountButton();
})();
