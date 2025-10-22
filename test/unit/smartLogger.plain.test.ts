import SmartLogger from '../../dist/smartLogger';
import fs from 'fs';
import path from 'path';

describe('SmartLogger plain/pretty output tests', () => {
  const outDir = path.join(__dirname, '..', 'tmp');
  beforeAll(() => {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    // cleanup files
    const files = fs.readdirSync(outDir);
    for (const f of files) fs.unlinkSync(path.join(outDir, f));
  });

  test('writes pretty/plain text to console and file when json=false', async () => {
    const filePath = path.join(outDir, 'plain.log');
    const logger = new SmartLogger({
      level: 'info',
      json: false,
      pretty: true,
  // use concrete level keys so both info and warn go to the same file
  files: { info: filePath, warn: filePath },
      bufferFlushIntervalMs: 50,
      bufferMaxSize: 1024,
    });

    // Log some messages
    logger.info('plain test message', { meta: 'x' });
    logger.warn('warn message');

    // wait for buffer flush
    await new Promise((r) => setTimeout(r, 250));

    // ensure file exists and contains plain text (not JSON)
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    // Should not be valid JSON array/object per-line (i.e., contain human readable message)
    expect(content).toMatch(/plain test message/);
    expect(content).toMatch(/warn message/);

    await logger.close();
  }, 10000);
});
