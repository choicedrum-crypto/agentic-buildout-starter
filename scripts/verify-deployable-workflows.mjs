import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function resolveRange() {
  const base = process.env.BASE_SHA || process.env.GITHUB_EVENT_BEFORE || '';
  const head = process.env.HEAD_SHA || process.env.GITHUB_SHA || 'HEAD';

  if (base && !/^0+$/.test(base)) {
    return [base, head];
  }

  return ['HEAD~1', head];
}

const [base, head] = resolveRange();
const changed = git(['diff', '--name-only', base, head])
  .split(/\r?\n/)
  .filter(Boolean);

const n8nSpecChanges = changed.filter((file) => /^n8n-workflows\/.+\.json$/.test(file));
const builderChanged = changed.includes('scripts/build-n8n-workflows.mjs');

if (n8nSpecChanges.length > 0 && !builderChanged) {
  console.error('n8n workflow specs changed without a matching builder/import implementation.');
  console.error('Changed n8n specs:');
  for (const file of n8nSpecChanges) {
    console.error(`- ${file}`);
  }
  console.error('');
  console.error('Add or update scripts/build-n8n-workflows.mjs so the workflow is actually published, or split pure documentation/spec work into a non-deploying task.');
  process.exit(1);
}

console.log('Deployable workflow check passed.');
