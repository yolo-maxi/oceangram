import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../services/markdownRenderer';

describe('renderMarkdown', () => {
  describe('headers', () => {
    it('renders h1-h6', () => {
      expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
      expect(renderMarkdown('## Sub')).toContain('<h2>Sub</h2>');
      expect(renderMarkdown('### H3')).toContain('<h3>H3</h3>');
      expect(renderMarkdown('###### H6')).toContain('<h6>H6</h6>');
    });
  });

  describe('lists', () => {
    it('renders unordered lists with -', () => {
      const result = renderMarkdown('- one\n- two');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>one</li>');
      expect(result).toContain('<li>two</li>');
      expect(result).toContain('</ul>');
    });

    it('renders unordered lists with *', () => {
      const result = renderMarkdown('* alpha\n* beta');
      expect(result).toContain('<li>alpha</li>');
    });
  });

  describe('code blocks', () => {
    it('renders fenced code blocks', () => {
      const result = renderMarkdown('```\nconst x = 1;\n```');
      expect(result).toContain('<pre><code>const x = 1;</code></pre>');
    });

    it('renders fenced code blocks with language hint', () => {
      const result = renderMarkdown('```ts\nlet y = 2;\n```');
      expect(result).toContain('<pre><code>let y = 2;</code></pre>');
    });
  });

  describe('inline code', () => {
    it('renders inline code', () => {
      const result = renderMarkdown('Use `npm install` here');
      expect(result).toContain('<code>npm install</code>');
    });
  });

  describe('links', () => {
    it('renders markdown links', () => {
      const result = renderMarkdown('[Google](https://google.com)');
      expect(result).toContain('<a href="https://google.com">Google</a>');
    });
  });

  describe('bold and italic', () => {
    it('renders bold with **', () => {
      const result = renderMarkdown('**bold text**');
      expect(result).toContain('<strong>bold text</strong>');
    });

    it('renders italic with *', () => {
      const result = renderMarkdown('*italic text*');
      expect(result).toContain('<em>italic text</em>');
    });

    it('renders bold+italic with ***', () => {
      const result = renderMarkdown('***both***');
      expect(result).toContain('<strong><em>both</em></strong>');
    });

    it('renders bold with __', () => {
      const result = renderMarkdown('__bold__');
      expect(result).toContain('<strong>bold</strong>');
    });
  });

  describe('blockquotes', () => {
    it('renders blockquotes', () => {
      const result = renderMarkdown('> A quote');
      expect(result).toContain('<blockquote>A quote</blockquote>');
    });
  });

  describe('XSS prevention', () => {
    it('escapes HTML tags in text', () => {
      const result = renderMarkdown('Hello <script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes HTML in headers', () => {
      const result = renderMarkdown('# <img onerror=alert(1)>');
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
    });

    it('escapes HTML in list items', () => {
      const result = renderMarkdown('- <b onmouseover=alert(1)>hover</b>');
      expect(result).not.toContain('<b ');
    });

    it('escapes HTML in code blocks', () => {
      const result = renderMarkdown('```\n<script>bad()</script>\n```');
      expect(result).not.toContain('<script>');
    });

    it('escapes HTML in link text', () => {
      const result = renderMarkdown('[<img src=x>](https://evil.com)');
      expect(result).not.toContain('<img');
    });

    it('strips javascript: URLs in links', () => {
      const result = renderMarkdown('[click](javascript:alert(1))');
      expect(result).not.toContain('javascript:');
      expect(result).toContain('click'); // text preserved
    });
  });

  describe('paragraphs', () => {
    it('wraps plain text in <p>', () => {
      const result = renderMarkdown('Hello world');
      expect(result).toContain('<p>Hello world</p>');
    });

    it('separates paragraphs on empty lines', () => {
      const result = renderMarkdown('First\n\nSecond');
      expect(result).toContain('<p>First</p>');
      expect(result).toContain('<p>Second</p>');
    });
  });

  describe('mixed content', () => {
    it('handles a realistic brief snippet', () => {
      const md = `# Project Rikai

> Reading assistant

## Status
- **Phase**: launched
- **Next**: Add limits

## Links
[Docs](https://docs.rikai.chat)

\`\`\`bash
pnpm install
\`\`\``;
      const result = renderMarkdown(md);
      expect(result).toContain('<h1>Project Rikai</h1>');
      expect(result).toContain('<blockquote>Reading assistant</blockquote>');
      expect(result).toContain('<strong>Phase</strong>');
      expect(result).toContain('<a href="https://docs.rikai.chat">Docs</a>');
      expect(result).toContain('<pre><code>pnpm install</code></pre>');
    });
  });
});
