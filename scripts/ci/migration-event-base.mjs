const commitPattern = /^[a-f0-9]{40}$/u;
const zeroCommit = '0'.repeat(40);

function fail() {
  throw new Error('MIGRATION_BASE_INVALID');
}

function exactCommit(value) {
  if (typeof value !== 'string' || !commitPattern.test(value) || value === zeroCommit) fail();
  return value;
}

export function resolveMigrationBaseSHA({ eventName, event, headSHA, resolveParent }) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
  let candidate;
  switch (eventName) {
    case 'pull_request':
      candidate = event.pull_request?.base?.sha;
      break;
    case 'merge_group':
      candidate = event.merge_group?.base_sha;
      break;
    case 'push':
      candidate = event.before;
      break;
    case 'workflow_dispatch':
      if (typeof resolveParent !== 'function') fail();
      candidate = resolveParent(exactCommit(headSHA));
      break;
    default:
      fail();
  }
  return exactCommit(candidate);
}
