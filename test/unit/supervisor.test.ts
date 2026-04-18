import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubSecrets } from '../../src/supervisor/index.js';

describe('scrubSecrets (used by Supervisor onStderr pipeline)', () => {
  it('redacts sk- API keys', () => {
    const cleaned = scrubSecrets('sk-test123456789 leaked');
    expect(cleaned).not.toContain('sk-test123456789');
    expect(cleaned).toContain('[REDACTED]');
  });

  it('redacts AWS AKIA access keys', () => {
    const cleaned = scrubSecrets('error AKIAABCDEFGHIJKLMNOP logged');
    expect(cleaned).toBe('error [REDACTED] logged');
  });

  it('leaves innocuous lines alone', () => {
    expect(scrubSecrets('just a log line')).toBe('just a log line');
  });
});

/**
 * Fix 1 integration-ish test: simulate the bootstrap log-sink wiring by
 * invoking the same callback shape on a temp directory. The Supervisor
 * pre-scrubs stderr before calling onChildStderr, so the file-writing sink
 * must receive and persist only redacted content.
 */
describe('bootstrap stderr log sink (SEC-003 wiring)', () => {
  it('writes scrubbed lines to <logDir>/<name>.log, never raw secrets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolhub-log-test-'));
    const logPath = path.join(tmpDir, 'mymcp.log');
    const stream = fs.createWriteStream(logPath, { flags: 'a' });

    // Emulate Supervisor.onStderr -> scrub -> sink flow:
    const rawLine = 'oops sk-test1234567890 leaked';
    const scrubbed = scrubSecrets(rawLine);
    const sink = (_name: string, line: string) => stream.write(line + '\n');
    sink('mymcp', scrubbed);
    stream.end();

    // Wait for flush
    return new Promise<void>((resolve, reject) => {
      stream.on('finish', () => {
        try {
          const contents = fs.readFileSync(logPath, 'utf8');
          expect(contents).toContain('[REDACTED]');
          expect(contents).not.toContain('sk-test1234567890');
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on('error', reject);
    });
  });
});
