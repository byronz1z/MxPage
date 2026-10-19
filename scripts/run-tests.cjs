const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.chdir(path.resolve(__dirname, '..'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mxpage-test-suite-'));
const env = { ...process.env, DATABASE_URL: `file:${path.join(directory, 'suite.db').replaceAll('\\', '/')}`, STORAGE_ROOT: path.join(directory, 'storage') };
try {
  const migration = spawnSync(process.execPath, ['scripts/apply-prisma-migrations.cjs'], { env, stdio: 'inherit', windowsHide: true });
  if (migration.error) throw migration.error;
  if (migration.status !== 0) process.exitCode = migration.status || 1;
  else {
    const tests = fs.readdirSync('tests').filter(name => /\.test\.tsx?$/.test(name)).sort().map(name => path.join('tests', name));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status || (result.signal ? 1 : 0);
  }
} finally {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mxpage-test-suite-')) throw new Error('Invalid test data path');
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
