const DEFAULT_URL = 'http://www.tciallc.com/';
const DEFAULT_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const options = {
    url: process.env.WEBSITE_CHECK_URL || DEFAULT_URL,
    timeoutMs: Number(process.env.WEBSITE_CHECK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') {
      options.url = argv[index + 1];
      index += 1;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.url) {
    throw new Error('A URL is required.');
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-website.mjs [--url URL] [--timeout-ms MS]

Checks whether a website responds with an HTTP 2xx or 3xx status.

Defaults:
  URL: ${DEFAULT_URL}
  Timeout: ${DEFAULT_TIMEOUT_MS}ms

Environment:
  WEBSITE_CHECK_URL
  WEBSITE_CHECK_TIMEOUT_MS`);
}

async function checkWebsite({ url, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'agentic-buildout-starter/website-checker',
      },
    });

    const durationMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      url,
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      durationMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const result = await checkWebsite(options);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  console.error(`${message}${cause}`);
  process.exitCode = 1;
}
