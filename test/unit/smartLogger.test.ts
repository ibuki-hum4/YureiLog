import SmartLogger from '../../dist/smartLogger';

describe('SmartLogger smoke tests', () => {
  test('can construct and log', () => {
    const logger = new SmartLogger({ level: 'debug', json: true });
    expect(typeof logger.log).toBe('function');
    logger.info('test message', { meta: 1 });
    logger.close();
  });
});
