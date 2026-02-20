import { describe, it, expect } from 'vitest';
import {
  parseToolCallsFromText,
  messageHasToolCalls,
  getToolIcon,
  truncateParams,
  truncateString,
  formatDuration
} from '../toolExecution';

describe('toolExecution', () => {
  describe('getToolIcon', () => {
    it('returns correct icon for known tools', () => {
      expect(getToolIcon('exec')).toBe('⚡');
      expect(getToolIcon('read')).toBe('📄');
      expect(getToolIcon('Read')).toBe('📄');
      expect(getToolIcon('browser')).toBe('🖥️');
    });

    it('returns default icon for unknown tools', () => {
      expect(getToolIcon('unknown')).toBe('🔨');
      expect(getToolIcon('custom_tool')).toBe('🔨');
    });
  });

  describe('truncateParams', () => {
    it('truncates command parameter', () => {
      const args = { command: 'echo "hello world this is a very long command that should be truncated"' };
      const result = truncateParams(args, 30);
      expect(result.length).toBeLessThanOrEqual(31);
      expect(result.endsWith('…')).toBe(true);
    });

    it('truncates file path with leading ellipsis', () => {
      const args = { file_path: '/very/long/path/to/some/deeply/nested/directory/file.ts' };
      const result = truncateParams(args, 30);
      expect(result.startsWith('…')).toBe(true);
    });

    it('handles empty args', () => {
      expect(truncateParams({})).toBe('');
    });

    it('shows query for web_search', () => {
      const args = { query: 'test search' };
      expect(truncateParams(args)).toBe('test search');
    });

    it('shows url for web_fetch', () => {
      const args = { url: 'https://example.com' };
      expect(truncateParams(args)).toBe('https://example.com');
    });

    it('shows action for message tool', () => {
      const args = { action: 'send' };
      expect(truncateParams(args)).toBe('send');
    });
  });

  describe('truncateString', () => {
    it('truncates long strings', () => {
      const long = 'a'.repeat(100);
      expect(truncateString(long, 20).length).toBe(21);
    });

    it('keeps short strings intact', () => {
      expect(truncateString('short', 20)).toBe('short');
    });

    it('handles empty strings', () => {
      expect(truncateString('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(truncateString('  hello  ')).toBe('hello');
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(30000)).toBe('30.0s');
    });

    it('formats minutes', () => {
      expect(formatDuration(90000)).toBe('1m30s');
      expect(formatDuration(120000)).toBe('2m0s');
    });

    it('handles negative values', () => {
      expect(formatDuration(-1)).toBe('?');
    });
  });

  describe('messageHasToolCalls', () => {
    it('returns false for empty text', () => {
      expect(messageHasToolCalls('')).toBe(false);
    });

    it('returns false for regular text', () => {
      expect(messageHasToolCalls('Hello world')).toBe(false);
    });

    it('returns true for text with invoke blocks', () => {
      const text = 'some text ' + String.fromCharCode(60) + 'invoke name="exec"' + String.fromCharCode(62);
      expect(messageHasToolCalls(text)).toBe(true);
    });

    it('returns true for text with function_calls', () => {
      const text = 'some text ' + String.fromCharCode(60) + 'function_calls' + String.fromCharCode(62);
      expect(messageHasToolCalls(text)).toBe(true);
    });
  });

  describe('parseToolCallsFromText', () => {
    it('returns empty array for empty text', () => {
      expect(parseToolCallsFromText('')).toEqual([]);
    });

    it('returns empty array for text without tool calls', () => {
      expect(parseToolCallsFromText('Hello, this is just regular text.')).toEqual([]);
    });

    it('parses simple invoke block', () => {
      // Build the XML string using character codes to avoid parsing issues
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      const text = `${lt}invoke name="exec"${gt}${lt}parameter name="command"${gt}ls -la${lt}/parameter${gt}${lt}/invoke${gt}`;
      
      const result = parseToolCallsFromText(text);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('exec');
      expect(result[0].params).toContain('ls');
    });

    it('parses multiple invoke blocks', () => {
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      const text = `
        ${lt}invoke name="read"${gt}${lt}parameter name="path"${gt}/tmp/test.txt${lt}/parameter${gt}${lt}/invoke${gt}
        ${lt}invoke name="exec"${gt}${lt}parameter name="command"${gt}cat /tmp/test.txt${lt}/parameter${gt}${lt}/invoke${gt}
      `;
      
      const result = parseToolCallsFromText(text);
      expect(result.length).toBe(2);
      expect(result[0].name).toBe('read');
      expect(result[1].name).toBe('exec');
    });

    it('extracts parameter summary correctly', () => {
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      
      // Test command param
      let text = `${lt}invoke name="exec"${gt}${lt}parameter name="command"${gt}echo hello${lt}/parameter${gt}${lt}/invoke${gt}`;
      let result = parseToolCallsFromText(text);
      expect(result[0].params).toBe('echo hello');
      
      // Test file_path param
      text = `${lt}invoke name="read"${gt}${lt}parameter name="file_path"${gt}/test.txt${lt}/parameter${gt}${lt}/invoke${gt}`;
      result = parseToolCallsFromText(text);
      expect(result[0].params).toBe('/test.txt');
      
      // Test query param
      text = `${lt}invoke name="web_search"${gt}${lt}parameter name="query"${gt}test query${lt}/parameter${gt}${lt}/invoke${gt}`;
      result = parseToolCallsFromText(text);
      expect(result[0].params).toBe('test query');
    });

    it('parses function_results for error detection', () => {
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      const text = `
        ${lt}invoke name="exec"${gt}${lt}parameter name="command"${gt}false${lt}/parameter${gt}${lt}/invoke${gt}
        ${lt}function_results${gt}Error: command failed with exit code 1${lt}/function_results${gt}
      `;
      
      const result = parseToolCallsFromText(text);
      expect(result.length).toBe(1);
      expect(result[0].isError).toBe(true);
      expect(result[0].fullResult).toContain('Error');
    });

    it('truncates long parameters', () => {
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      const longCommand = 'a'.repeat(100);
      const text = `${lt}invoke name="exec"${gt}${lt}parameter name="command"${gt}${longCommand}${lt}/parameter${gt}${lt}/invoke${gt}`;
      
      const result = parseToolCallsFromText(text);
      expect(result[0].params.length).toBeLessThan(longCommand.length);
      expect(result[0].params.endsWith('…')).toBe(true);
    });

    it('handles antml namespace prefix', () => {
      const lt = String.fromCharCode(60);
      const gt = String.fromCharCode(62);
      const text = `${lt}antml:invoke name="read"${gt}${lt}antml:parameter name="path"${gt}/test${lt}/antml:parameter${gt}${lt}/antml:invoke${gt}`;
      
      const result = parseToolCallsFromText(text);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('read');
    });
  });
});
