const SmartLogger = require('../dist/smartLogger').default;
const { performance } = require('perf_hooks');

function runScenario({ count = 10000, file = null, files = null, json = false, label = 'bench' }){
  const logger = new SmartLogger({ level: 'debug', json, file, files, bufferFlushIntervalMs: 50, bufferMaxSize: 500 });
  const start = performance.now();
  for (let i = 0; i < count; i++){
    logger.info('bench message ' + i, { i });
  }
  // ensure flush
  setTimeout(()=>{
    const end = performance.now();
    const duration = (end - start) / 1000;
    console.log(`${label}: ${count} logs in ${duration.toFixed(3)}s => ${(count/duration).toFixed(0)} logs/s`);
    logger.close();
  }, 1000);
}

(async ()=>{
  console.log('Running bench scenarios (10000 logs each)');
  await new Promise(r=>{
    runScenario({ count: 10000, file: './bench/combined.log', json: false, label: 'single-file-buffered' });
    setTimeout(()=> runScenario({ count: 10000, files: { error: './bench/error.log', info: './bench/combined.log' }, json: false, label: 'per-level-buffered' }), 2500);
    setTimeout(()=> runScenario({ count: 10000, file: null, json: false, label: 'console-only' }), 5000);
    setTimeout(r, 8000);
  });
})();
