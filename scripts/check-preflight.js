const { execSync } = require('child_process');
try {
  console.log('Running preflight checks...');
  execSync('npm ci', { stdio: 'inherit' });
  execSync('npm run build', { stdio: 'inherit' });
  execSync('npm test', { stdio: 'inherit' });
  execSync('npm pack --dry-run', { stdio: 'inherit' });
  console.log('\nPreflight checks passed.');
} catch (e) {
  console.error('\nPreflight failed:', e.message);
  process.exit(1);
}
