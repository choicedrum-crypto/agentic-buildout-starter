import fs from 'node:fs';

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[^#=]+=/.test(line))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const endpoint = env.N8N_BASE_URL.replace(/\/$/, '');
let id = 1;

function parseMcpResponse(text) {
  const match = text.match(/^data: (.*)$/m);
  return match ? JSON.parse(match[1]) : JSON.parse(text);
}

async function mcp(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.N8N_API_KEY}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  const payload = parseMcpResponse(await response.text());
  if (payload.error) {
    throw new Error(JSON.stringify(payload.error));
  }
  return payload.result;
}

async function tool(name, args = {}) {
  return mcp('tools/call', { name, arguments: args });
}

const tempName = `TEMP List Plane States ${Date.now()}`;

const code = `
import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start' }
});

const listStates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Plane States',
    credentials: { httpHeaderAuth: newCredential('Header Auth account') },
    parameters: {
      method: 'GET',
      url: 'https://api.plane.so/api/v1/workspaces/tcia/projects/TCIA/states/',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }
    }
  }
});

const summarize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarize Plane States',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: \`
const items = $input.all();
const rows = [];
for (const item of items) {
  const value = item.json;
  const states = Array.isArray(value) ? value : Array.isArray(value.results) ? value.results : Array.isArray(value.data) ? value.data : [value];
  for (const state of states) {
    if (state && state.id && state.name) {
      rows.push({ id: state.id, name: state.name, group: state.group || '', default: Boolean(state.default) });
    }
  }
}
return [{ json: { states: rows } }];
\`
    }
  }
});

export default workflow('temp-list-plane-states', '${'${tempName}'}')
  .add(start)
  .to(listStates)
  .to(summarize);
`;

await mcp('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'codex-local', version: '1.0.0' },
});

const validation = await tool('validate_workflow', { code });
if (validation.structuredContent?.valid === false) {
  console.log(JSON.stringify(validation, null, 2));
  process.exit(1);
}

await tool('create_workflow_from_code', {
  code,
  name: tempName,
  description: 'Temporary workflow to list Plane project state UUIDs.',
});

const search = await tool('search_workflows', { query: tempName, limit: 20 });
const tempWorkflow = (search.structuredContent?.data || []).find((workflowItem) => workflowItem.name === tempName);
if (!tempWorkflow) {
  throw new Error('Temporary workflow was not found after creation.');
}

try {
  const execution = await tool('execute_workflow', {
    workflowId: tempWorkflow.id,
    executionMode: 'manual',
  });
  const executionId = (execution.structuredContent || execution).executionId;

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const details = await tool('get_execution', {
    workflowId: tempWorkflow.id,
    executionId,
    includeData: true,
    nodeNames: ['Summarize Plane States'],
    truncateData: 100,
  });

  const payload = details.structuredContent || details;
  const serialized = JSON.stringify(payload);
  let parsed = [];
  const statesArrayMatch = serialized.match(/"states":(\[[\s\S]*?\])/);
  if (statesArrayMatch) {
    try {
      parsed = JSON.parse(statesArrayMatch[1]);
    } catch {
      parsed = [];
    }
  }
  if (parsed.length === 0) {
    const regex = /"id":"([^"]+)"[\s\S]{0,1200}?"name":"([^"]+)"[\s\S]{0,1200}?"group":"([^"]*)"/g;
    for (const match of serialized.matchAll(regex)) {
      parsed.push({ id: match[1], name: match[2], group: match[3] });
    }
  }

  console.log(JSON.stringify({ workflowId: tempWorkflow.id, executionId, states: parsed, rawPreview: parsed.length ? undefined : serialized.slice(0, 2000) }, null, 2));
} finally {
  await tool('archive_workflow', { workflowId: tempWorkflow.id });
}
