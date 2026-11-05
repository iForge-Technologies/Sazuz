import { describe, expect, it } from 'vitest';
import { scanText } from './actions.js';
describe('quarantined browser downloads', () => {
  it('admits bounded UTF-8 data and rejects executables, active content, invalid JSON and formulas', () => {
    expect(scanText('data.csv', Buffer.from('name,count\nA,2'))).toContain('A,2');
    expect(scanText('data.json', Buffer.from('{"count":2}'))).toBe('{"count":2}');
    for (const [name, body] of [
      ['file.exe', 'MZ'],
      ['page.txt', '<script>alert(1)</script>'],
      ['sheet.csv', '=IMPORTXML("https://example.com")'],
      ['file.json', 'invalid'],
      ['file.txt', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE'],
    ])
      expect(() => scanText(name!, Buffer.from(body!))).toThrow();
    expect(() => scanText('file.txt', Buffer.alloc(262145, 65))).toThrow();
  });
});
