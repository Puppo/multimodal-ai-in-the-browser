import { describe, expect, it } from 'vitest';
import { parseInlineTokens, parseMarkdownBlocks } from '../../src/ui/markdown';

describe('safe Markdown parser', () => {
  it('parses the Gemini Nano bulleted response structure accurately', () => {
    const sample = [
      'Based on the image, here is a list of the visible objects and their approximate locations:',
      '',
      '**On the Desk/Table (Foreground):**',
      '',
      '  * **Laptop:** Positioned in the center-left of the desk.',
      '  * **Desk Lamp:** A black, articulated desk lamp positioned to the left of the laptop.',
      '',
      '**In the Background:**',
      '',
      '  * **Wall/Background:** The background is almost entirely a plain, bright white wall.',
      '',
      'In summary, the scene depicts a typical workspace.',
    ].join('\n');

    const blocks = parseMarkdownBlocks(sample);
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'list',
      'paragraph',
      'list',
      'paragraph',
    ]);

    const firstList = blocks[2];
    expect(firstList?.type).toBe('list');
    if (firstList?.type === 'list') {
      expect(firstList.ordered).toBe(false);
      expect(firstList.items).toHaveLength(2);
      expect(firstList.items[0]?.lines[0]?.[0]).toEqual({
        type: 'strong',
        children: [{ type: 'text', value: 'Laptop:' }],
      });
    }
  });

  it('supports nested lists, ordered lists, blockquotes, headings, and hr', () => {
    const md = [
      '### Findings',
      '',
      '1. Top item',
      '   - Nested bullet with *emphasis*',
      '2. Second item',
      '',
      '> Quoted observation',
      '',
      '---',
    ].join('\n');

    const blocks = parseMarkdownBlocks(md);
    expect(blocks[0]).toEqual({
      type: 'heading',
      level: 3,
      tokens: [{ type: 'text', value: 'Findings' }],
    });

    const list = blocks[1];
    expect(list?.type).toBe('list');
    if (list?.type === 'list') {
      expect(list.ordered).toBe(true);
      expect(list.items).toHaveLength(2);
      expect(list.items[0]?.sublists).toHaveLength(1);
      expect(list.items[0]?.sublists[0]?.ordered).toBe(false);
    }

    expect(blocks[2]?.type).toBe('blockquote');
    expect(blocks[3]).toEqual({ type: 'hr' });
  });

  it('parses closed and streaming unclosed fenced code blocks literally', () => {
    const closed = parseMarkdownBlocks('```ts\nconst x = "**not bold**";\n```');
    expect(closed).toEqual([
      {
        type: 'code',
        language: 'ts',
        code: 'const x = "**not bold**";',
      },
    ]);

    const streaming = parseMarkdownBlocks('```json\n{"key": "partial"');
    expect(streaming).toEqual([
      {
        type: 'code',
        language: 'json',
        code: '{"key": "partial"',
      },
    ]);
  });

  it('preserves OCR multi-line line breaks within paragraphs', () => {
    const blocks = parseMarkdownBlocks('ELECTRIC FENCE\nG602000');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        lines: [
          [{ type: 'text', value: 'ELECTRIC FENCE' }],
          [{ type: 'text', value: 'G602000' }],
        ],
      },
    ]);
  });

  it('handles inline code, snake_case identifiers, and leaves raw HTML and links inert', () => {
    expect(
      parseInlineTokens('Use `**literal**` and decoder_model_merged.'),
    ).toEqual([
      { type: 'text', value: 'Use ' },
      { type: 'code', value: '**literal**' },
      { type: 'text', value: ' and decoder_model_merged.' },
    ]);

    expect(parseInlineTokens('2 * 3 * 4 equals 24')).toEqual([
      { type: 'text', value: '2 * 3 * 4 equals 24' },
    ]);

    const untrusted = parseInlineTokens(
      '<img src=x onerror=1> and ![beacon](https://evil.example/p)',
    );
    expect(untrusted).toEqual([
      {
        type: 'text',
        value: '<img src=x onerror=1> and ![beacon](https://evil.example/p)',
      },
    ]);
  });
});
