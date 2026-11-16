export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] };

export interface MarkdownListItem {
  lines: InlineToken[][];
  sublists: MarkdownListBlock[];
}

export interface MarkdownListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: MarkdownListItem[];
}

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; tokens: InlineToken[] }
  | { type: 'paragraph'; lines: InlineToken[][] }
  | { type: 'code'; language: string; code: string }
  | { type: 'blockquote'; blocks: MarkdownBlock[] }
  | { type: 'hr' }
  | MarkdownListBlock;

const FENCE_RE = /^\s*```([^\s`]*)\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const UNORDERED_LIST_RE = /^([ \t]*)[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^([ \t]*)(\d+)[.)]\s+(.*)$/;

function measureIndent(whitespace: string): number {
  let indent = 0;
  for (const ch of whitespace) {
    indent += ch === '\t' ? 2 : 1;
  }
  return indent;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function findClosingDouble(
  text: string,
  from: number,
  marker: '**' | '__',
): number {
  let idx = text.indexOf(marker, from);
  while (idx !== -1) {
    const prev = text[idx - 1];
    const next = text[idx + 2];
    if (prev !== undefined && !/\s/.test(prev)) {
      if (marker === '**' || !isWordChar(next)) {
        return idx;
      }
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return -1;
}

function findClosingSingle(
  text: string,
  from: number,
  marker: '*' | '_',
): number {
  let idx = text.indexOf(marker, from);
  while (idx !== -1) {
    const prev = text[idx - 1];
    const next = text[idx + 1];
    // Skip doubled markers when scanning for a closing single marker
    if (next === marker) {
      idx = text.indexOf(marker, idx + 2);
      continue;
    }
    if (prev !== undefined && !/\s/.test(prev)) {
      if (marker === '*' || !isWordChar(next)) {
        return idx;
      }
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return -1;
}

export function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      tokens.push({ type: 'text', value: text.slice(plainStart, end) });
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // 1. Escaped ASCII punctuation (e.g., \* or \`)
    if (ch === '\\' && i + 1 < text.length) {
      const escaped = text[i + 1];
      if (escaped !== undefined && /[*_`\\]/.test(escaped)) {
        flushPlain(i);
        tokens.push({ type: 'text', value: escaped });
        i += 2;
        plainStart = i;
        continue;
      }
    }

    // 2. Inline code `...`
    if (ch === '`') {
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        flushPlain(i);
        tokens.push({ type: 'code', value: text.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }

    // 3. Bold-italic ***...*** or ___...___
    if (
      (text.startsWith('***', i) ||
        (text.startsWith('___', i) && !isWordChar(text[i - 1]))) &&
      i + 3 < text.length &&
      !/\s/.test(text[i + 3] ?? '')
    ) {
      const marker = text.slice(i, i + 3);
      let closeIdx = text.indexOf(marker, i + 3);
      while (closeIdx !== -1) {
        const prev = text[closeIdx - 1];
        const after = text[closeIdx + 3];
        if (
          prev !== undefined &&
          !/\s/.test(prev) &&
          (marker === '***' || !isWordChar(after))
        ) {
          flushPlain(i);
          tokens.push({
            type: 'strong',
            children: [
              {
                type: 'em',
                children: parseInlineTokens(text.slice(i + 3, closeIdx)),
              },
            ],
          });
          i = closeIdx + 3;
          plainStart = i;
          break;
        }
        closeIdx = text.indexOf(marker, closeIdx + 1);
      }
      if (plainStart === i && i > 0) {
        continue;
      }
    }

    // 4. Bold **...** or __...__
    if (
      (text.startsWith('**', i) ||
        (text.startsWith('__', i) && !isWordChar(text[i - 1]))) &&
      i + 2 < text.length &&
      !/\s/.test(text[i + 2] ?? '')
    ) {
      const marker = text.slice(i, i + 2) as '**' | '__';
      const closeIdx = findClosingDouble(text, i + 2, marker);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flushPlain(i);
        tokens.push({
          type: 'strong',
          children: parseInlineTokens(text.slice(i + 2, closeIdx)),
        });
        i = closeIdx + 2;
        plainStart = i;
        continue;
      }
    }

    // 5. Italic *...* or word-bounded _..._
    if (
      (ch === '*' || (ch === '_' && !isWordChar(text[i - 1]))) &&
      i + 1 < text.length &&
      text[i + 1] !== ch &&
      !/\s/.test(text[i + 1] ?? '')
    ) {
      const closeIdx = findClosingSingle(text, i + 1, ch);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        flushPlain(i);
        tokens.push({
          type: 'em',
          children: parseInlineTokens(text.slice(i + 1, closeIdx)),
        });
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushPlain(text.length);
  return tokens;
}

interface ParsedListMarker {
  ordered: boolean;
  start: number;
  indent: number;
  content: string;
}

function matchListMarker(line: string): ParsedListMarker | null {
  const unordered = UNORDERED_LIST_RE.exec(line);
  if (unordered) {
    return {
      ordered: false,
      start: 1,
      indent: measureIndent(unordered[1] ?? ''),
      content: unordered[2] ?? '',
    };
  }
  const ordered = ORDERED_LIST_RE.exec(line);
  if (ordered) {
    return {
      ordered: true,
      start: Number.parseInt(ordered[2] ?? '1', 10) || 1,
      indent: measureIndent(ordered[1] ?? ''),
      content: ordered[3] ?? '',
    };
  }
  return null;
}

function isBlockStarter(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    matchListMarker(line) !== null
  );
}

function parseListBlock(
  lines: string[],
  startIdx: number,
): { block: MarkdownListBlock; nextIdx: number } {
  const firstMarker = matchListMarker(lines[startIdx] ?? '');
  if (!firstMarker) {
    throw new Error('Expected list item marker');
  }

  const baseIndent = firstMarker.indent;
  const ordered = firstMarker.ordered;
  const start = firstMarker.start;
  const items: MarkdownListItem[] = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx] ?? '';
    if (line.trim() === '') {
      let lookahead = idx + 1;
      while (
        lookahead < lines.length &&
        (lines[lookahead] ?? '').trim() === ''
      ) {
        lookahead += 1;
      }
      if (lookahead >= lines.length) {
        idx = lookahead;
        break;
      }
      const nextMarker = matchListMarker(lines[lookahead] ?? '');
      if (
        nextMarker &&
        nextMarker.ordered === ordered &&
        nextMarker.indent >= baseIndent
      ) {
        idx = lookahead;
        continue;
      }
      break;
    }

    const marker = matchListMarker(line);
    if (marker) {
      if (marker.indent < baseIndent) {
        break;
      }
      if (marker.indent >= baseIndent + 2) {
        const previousItem = items.at(-1);
        if (previousItem) {
          const nested = parseListBlock(lines, idx);
          previousItem.sublists.push(nested.block);
          idx = nested.nextIdx;
          continue;
        }
      }
      if (marker.ordered !== ordered && marker.indent <= baseIndent + 1) {
        break;
      }
      items.push({
        lines: [parseInlineTokens(marker.content)],
        sublists: [],
      });
      idx += 1;
      continue;
    }

    // Continuation text line attached to the active list item when indented
    const leadingIndent = measureIndent(/^([ \t]*)/.exec(line)?.[1] ?? '');
    const previousItem = items.at(-1);
    if (previousItem && leadingIndent > baseIndent && !isBlockStarter(line)) {
      previousItem.lines.push(parseInlineTokens(line.trim()));
      idx += 1;
      continue;
    }

    break;
  }

  return {
    block: {
      type: 'list',
      ordered,
      start,
      items,
    },
    nextIdx: idx,
  };
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({
        type: 'code',
        language,
        code: codeLines.join('\n'),
      });
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, (headingMatch[1] ?? '#').length)) as
        | 1
        | 2
        | 3
        | 4
        | 5
        | 6;
      blocks.push({
        type: 'heading',
        level,
        tokens: parseInlineTokens(headingMatch[2] ?? ''),
      });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const quoteMatch = BLOCKQUOTE_RE.exec(lines[i] ?? '');
        if (!quoteMatch) {
          break;
        }
        quoteLines.push(quoteMatch[1] ?? '');
        i += 1;
      }
      blocks.push({
        type: 'blockquote',
        blocks: parseMarkdownBlocks(quoteLines.join('\n')),
      });
      continue;
    }

    if (matchListMarker(line)) {
      const parsed = parseListBlock(lines, i);
      blocks.push(parsed.block);
      i = parsed.nextIdx;
      continue;
    }

    const paragraphLines: InlineToken[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (current.trim() === '' || isBlockStarter(current)) {
        break;
      }
      paragraphLines.push(parseInlineTokens(current));
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        lines: paragraphLines,
      });
    }
  }

  return blocks;
}

function appendInlineNodes(parent: Node, tokens: readonly InlineToken[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        parent.appendChild(document.createTextNode(token.value));
        break;
      case 'code': {
        const codeEl = document.createElement('code');
        codeEl.textContent = token.value;
        parent.appendChild(codeEl);
        break;
      }
      case 'strong': {
        const strongEl = document.createElement('strong');
        appendInlineNodes(strongEl, token.children);
        parent.appendChild(strongEl);
        break;
      }
      case 'em': {
        const emEl = document.createElement('em');
        appendInlineNodes(emEl, token.children);
        parent.appendChild(emEl);
        break;
      }
    }
  }
}

function appendLinesWithBreaks(
  parent: Node,
  lines: readonly InlineToken[][],
): void {
  lines.forEach((lineTokens, index) => {
    if (index > 0) {
      parent.appendChild(document.createElement('br'));
    }
    appendInlineNodes(parent, lineTokens);
  });
}

function createListElement(block: MarkdownListBlock): HTMLElement {
  const listEl = document.createElement(block.ordered ? 'ol' : 'ul');
  if (block.ordered && block.start !== 1) {
    listEl.setAttribute('start', String(block.start));
  }

  for (const item of block.items) {
    const li = document.createElement('li');
    appendLinesWithBreaks(li, item.lines);
    for (const sublist of item.sublists) {
      li.appendChild(createListElement(sublist));
    }
    listEl.appendChild(li);
  }

  return listEl;
}

function appendBlockElements(
  parent: Node,
  blocks: readonly MarkdownBlock[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        // Render as styled <p> rather than <h1>-<h6> so untrusted model output
        // cannot alter the page's assistive-technology heading outline.
        const headingEl = document.createElement('p');
        headingEl.className = 'md-heading';
        headingEl.dataset.level = String(block.level);
        appendInlineNodes(headingEl, block.tokens);
        parent.appendChild(headingEl);
        break;
      }
      case 'paragraph': {
        const p = document.createElement('p');
        appendLinesWithBreaks(p, block.lines);
        parent.appendChild(p);
        break;
      }
      case 'code': {
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        if (block.language.length > 0) {
          codeEl.dataset.language = block.language;
        }
        codeEl.textContent = block.code;
        pre.appendChild(codeEl);
        parent.appendChild(pre);
        break;
      }
      case 'blockquote': {
        const quote = document.createElement('blockquote');
        appendBlockElements(quote, block.blocks);
        parent.appendChild(quote);
        break;
      }
      case 'hr':
        parent.appendChild(document.createElement('hr'));
        break;
      case 'list':
        parent.appendChild(createListElement(block));
        break;
    }
  }
}

export function renderSafeMarkdown(
  container: HTMLElement,
  markdown: string,
): void {
  const fragment = document.createDocumentFragment();
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) {
    const p = document.createElement('p');
    p.textContent = markdown;
    fragment.appendChild(p);
  } else {
    appendBlockElements(fragment, blocks);
  }
  container.replaceChildren(fragment);
}
