import fs from 'node:fs';

function readLocalEnv() {
  if (!fs.existsSync('.env.local')) {
    return {};
  }

  return Object.fromEntries(
    fs
      .readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[^#=]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

const env = { ...readLocalEnv(), ...process.env };

for (const key of ['N8N_BASE_URL', 'N8N_API_KEY']) {
  if (!env[key]) {
    throw new Error(`${key} is required in the environment or .env.local`);
  }
}

const endpoint = env.N8N_BASE_URL.replace(/\/$/, '');
let id = 1;
const maxMcpAttempts = Number(env.N8N_MCP_MAX_ATTEMPTS || 5);
const mcpRetryBaseMs = Number(env.N8N_MCP_RETRY_BASE_MS || 2500);
const workflowSearchAttempts = Number(env.N8N_WORKFLOW_SEARCH_ATTEMPTS || 6);
const workflowSearchRetryMs = Number(env.N8N_WORKFLOW_SEARCH_RETRY_MS || 2500);

function parseMcpResponse(text) {
  const match = text.match(/^data: (.*)$/m);
  return match ? JSON.parse(match[1]) : JSON.parse(text);
}

async function mcp(method, params = {}) {
  const requestId = id++;
  let lastError;

  for (let attempt = 1; attempt <= maxMcpAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.N8N_API_KEY}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      });
      const payload = parseMcpResponse(await response.text());
      if (payload.error) {
        throw new Error(JSON.stringify(payload.error));
      }
      return payload.result;
    } catch (error) {
      lastError = error;
      if (attempt === maxMcpAttempts) break;
      const waitMs = mcpRetryBaseMs * attempt;
      console.warn(`n8n MCP ${method} failed on attempt ${attempt}/${maxMcpAttempts}; retrying in ${waitMs}ms: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

async function tool(name, args = {}) {
  return mcp('tools/call', { name, arguments: args });
}

async function findWorkflowByName(name) {
  for (let attempt = 1; attempt <= workflowSearchAttempts; attempt += 1) {
    const search = await tool('search_workflows', { query: name, limit: 20 });
    const match = getStructuredContent(search).data?.find((workflowItem) => workflowItem.name === name && workflowItem.id);
    if (match) {
      return match;
    }

    if (attempt < workflowSearchAttempts) {
      console.warn(`workflow ${name} not found after create on attempt ${attempt}/${workflowSearchAttempts}; retrying in ${workflowSearchRetryMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, workflowSearchRetryMs));
    }
  }

  return undefined;
}

function getStructuredContent(result) {
  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const planeApiCredential = 'Plane Main';
const githubCredential = 'GitHub account';

const planeReadyWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const planeWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Plane Ready Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'plane-ready',
      responseMode: 'responseNode',
      options: { rawBody: true }
    }
  }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_project_identifier: "TCIA", plane_ready_state_id: "372009ad-e7bc-4639-9390-5540a123e435", plane_ready_state_name: "Ready", plane_ready_lock_table_id: "elEXsB0XF3eRoKKf", plane_ready_lock_table_name: "plane_ready_issue_locks", plane_signature_validation: "pending-secret-credential", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }
        ]
      }
    }
  }
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Plane Payload',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
const issue = body.issue || body.work_item || body.workItem || body.data || body;
const stateObject = issue.state || issue.status || body.state || body.status || {};
const stateValue = stateObject.name || issue.state_name || issue.status_name || body.state_name || body.status_name || stateObject || '';
const stateId = stateObject.id || stateObject.uuid || issue.state_id || issue.state || body.state_id || body.state || '';
const planeIssueId = issue.id || issue.uuid || issue.issue_id || issue.work_item_id || body.issue_id || body.work_item_id || '';
const planeIssueKey = issue.identifier || issue.sequence_id || issue.key || body.issue_key || '';
const title = issue.name || issue.title || body.title || 'Plane task ready for Codex';
const description = issue.description_html || issue.description_stripped || issue.description || body.description || '';
const planeUrl = issue.url || issue.web_url || body.url || body.issue_url || '';
const existing = issue.github_issue_url || issue.external_id || body.github_issue_url || '';
const readyByName = String(stateValue).toLowerCase() === String(config.plane_ready_state_name || 'Ready').toLowerCase();
const readyById = String(stateId) === String(config.plane_ready_state_id || '');
const ready = readyByName || readyById;
const issueBody = [
  '## Plane Task',
  '- Plane URL: ' + (planeUrl || 'Not provided'),
  '- Plane ID: ' + (planeIssueId || 'Not provided'),
  '- Plane Key: ' + (planeIssueKey || 'Not provided'),
  '',
  '## Goal',
  title,
  '',
  '## Details',
  description || 'No Plane description provided.',
  '',
  '## Acceptance Criteria',
  '- Implement the requested change.',
  '- Add or update validation appropriate to the change.',
  '- Open a GitHub PR against main.',
  '- Include summary, tests, risks, and next steps in the PR.',
  '',
  '## Codex Instructions',
  '- Create a feature branch; do not commit directly to main.',
  '- Build and test locally.',
  '- Do not deploy from Codex.',
  '- Keep secrets out of files and logs.',
  '- Open a PR when ready for review.',
  '',
  '## Automation Metadata',
  'plane_issue_id: ' + planeIssueId,
  'plane_url: ' + planeUrl
].join('\\\\n');
return { json: { ...$json, config, plane_issue_id: planeIssueId, plane_issue_key: planeIssueKey, plane_title: title, plane_description: description, plane_state: stateValue, plane_state_id: stateId, plane_url: planeUrl, existing_github_issue_url: existing, ready, has_existing_github_issue: Boolean(existing), github_issue_title: '[Plane] ' + title, github_issue_body: issueBody } };
\`
    }
  }
});

const isReady = ifElse({
  version: 2.3,
  config: {
    name: 'State is Ready?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ String($json.ready) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }],
        combinator: 'and'
      }
    }
  }
});

const noExistingIssue = ifElse({
  version: 2.3,
  config: {
    name: 'No Existing GitHub Issue?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ String($json.has_existing_github_issue) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'false' }],
        combinator: 'and'
      }
    }
  }
});

const searchExistingGitHubIssues = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Search Existing GitHub Issues',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/search/issues?q=" + encodeURIComponent("repo:" + $json.config.github_owner + "/" + $json.config.github_repo + " type:issue plane_issue_id: " + $json.plane_issue_id) + "&sort=created&order=asc" }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const detectExistingGitHubIssue = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Detect Existing GitHub Issue',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Normalize Plane Payload').item.json;
const value = $json;
let existingUrl = original.existing_github_issue_url || '';
const issues = Array.isArray(value.items) ? value.items : [];
const exactIssues = issues
  .filter((issue) => !issue.pull_request && String(issue.body || '').includes('plane_issue_id: ' + original.plane_issue_id))
  .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
const openIssue = exactIssues.find((issue) => String(issue.state || '').toLowerCase() === 'open');
if (openIssue?.html_url) {
  existingUrl = openIssue.html_url;
}
return {
  json: {
    ...original,
    existing_github_issue_url: existingUrl,
    existing_github_issue_number: openIssue?.number || '',
    closed_github_issue_count: exactIssues.filter((issue) => String(issue.state || '').toLowerCase() === 'closed').length,
    has_existing_github_issue: Boolean(existingUrl),
  },
};
\`
    }
  }
});

const createIssue = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Create GitHub Issue',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'create',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      title: expr('{{ $json.github_issue_title }}'),
      body: expr('{{ $json.github_issue_body }}'),
      labels: [{ label: 'plane' }, { label: 'codex-ready' }, { label: 'automation' }]
    }
  }
});

const waitForGitHubIndex = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait for GitHub Search Consistency',
    parameters: {
      resume: 'timeInterval',
      amount: 20,
      unit: 'seconds'
    }
  }
});

const searchCanonicalGitHubIssue = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Search Canonical GitHub Issue',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/search/issues?q=" + encodeURIComponent("repo:" + $("Normalize Plane Payload").item.json.config.github_owner + "/" + $("Normalize Plane Payload").item.json.config.github_repo + " type:issue plane_issue_id: " + $("Normalize Plane Payload").item.json.plane_issue_id) + "&sort=created&order=asc" }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const resolveCanonicalGitHubIssue = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Canonical GitHub Issue',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Normalize Plane Payload').item.json;
const created = $('Create GitHub Issue').item.json;
const issues = Array.isArray($json.items) ? $json.items : [];
const exactIssues = issues
  .filter((issue) => !issue.pull_request && String(issue.body || '').includes('plane_issue_id: ' + original.plane_issue_id))
  .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
const openIssues = exactIssues.filter((issue) => String(issue.state || '').toLowerCase() === 'open');
const canonical = openIssues.sort((a, b) => Number(a.number || 0) - Number(b.number || 0))[0] || created;
const duplicateCreated = Boolean(created.number && canonical.number && Number(created.number) !== Number(canonical.number));
return {
  json: {
    ...original,
    created_github_issue_url: created.html_url,
    created_github_issue_number: created.number,
    canonical_github_issue_url: canonical.html_url || created.html_url,
    canonical_github_issue_number: canonical.number || created.number,
    closed_github_issue_count: exactIssues.filter((issue) => String(issue.state || '').toLowerCase() === 'closed').length,
    duplicate_created: duplicateCreated,
  },
};
\`
    }
  }
});

const upsertIssueLock = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Upsert Plane Issue Lock',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'elEXsB0XF3eRoKKf', cachedResultName: 'plane_ready_issue_locks' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'plane_issue_id', condition: 'eq', keyValue: expr('{{ $("Normalize Plane Payload").item.json.plane_issue_id }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: ['plane_issue_id'],
        value: {
          plane_issue_id: expr('{{ $("Normalize Plane Payload").item.json.plane_issue_id }}'),
          plane_issue_key: expr('{{ $("Normalize Plane Payload").item.json.plane_issue_key }}'),
          status: expr('{{ $("Resolve Canonical GitHub Issue").item.json.duplicate_created ? "deduped" : "active" }}'),
          github_issue_url: expr('{{ $("Resolve Canonical GitHub Issue").item.json.canonical_github_issue_url }}'),
          github_issue_number: expr('{{ Number($("Resolve Canonical GitHub Issue").item.json.canonical_github_issue_number || 0) }}'),
          delivery_id: expr('{{ $json.headers?.["x-plane-delivery"] || $json.headers?.["x-webhook-delivery"] || "" }}'),
          last_seen_at: expr('{{ new Date().toISOString() }}')
        },
        schema: [
          { id: 'plane_issue_id', displayName: 'plane_issue_id', required: true, defaultMatch: true, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'plane_issue_key', displayName: 'plane_issue_key', display: true, type: 'string' },
          { id: 'status', displayName: 'status', display: true, type: 'string' },
          { id: 'github_issue_url', displayName: 'github_issue_url', display: true, type: 'string' },
          { id: 'github_issue_number', displayName: 'github_issue_number', display: true, type: 'number' },
          { id: 'delivery_id', displayName: 'delivery_id', display: true, type: 'string' },
          { id: 'last_seen_at', displayName: 'last_seen_at', display: true, type: 'date' }
        ]
      }
    }
  }
});

const duplicateCreated = ifElse({
  version: 2.3,
  config: {
    name: 'Duplicate Issue Created?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ String($("Resolve Canonical GitHub Issue").item.json.duplicate_created) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }],
        combinator: 'and'
      }
    }
  }
});

const closeDuplicateIssue = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Close Duplicate GitHub Issue',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'edit',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($("Resolve Canonical GitHub Issue").item.json.created_github_issue_number) }}'),
      editFields: {
        state: 'closed',
        state_reason: 'not_planned',
        labels: [{ label: 'plane' }, { label: 'duplicate' }, { label: 'automation' }]
      }
    }
  }
});

const commentPlane = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Comment on Plane with GitHub Issue',
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ $("Normalize Plane Payload").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Normalize Plane Payload").item.json.config.plane_workspace_slug + "/projects/" + $("Normalize Plane Payload").item.json.config.plane_project_id + "/work-items/" + $("Normalize Plane Payload").item.json.plane_issue_id + "/comments/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { comment_html: "<p>GitHub issue " + ($("Resolve Canonical GitHub Issue").item.json.duplicate_created ? "deduped to canonical issue" : ($("Resolve Canonical GitHub Issue").item.json.closed_github_issue_count ? "created because previous linked issue was closed" : "created")) + ": " + $("Resolve Canonical GitHub Issue").item.json.canonical_github_issue_url + "</p>", comment_json: {}, access: "INTERNAL", external_source: "github", external_id: String(($("Resolve Canonical GitHub Issue").item.json.canonical_github_issue_number || "github") + "-" + Date.now()) } }}')
    }
  }
});

const respondCreated = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Created',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ { ok: true, action: $("Resolve Canonical GitHub Issue").item.json.duplicate_created ? "canonical_github_issue" : ($("Resolve Canonical GitHub Issue").item.json.closed_github_issue_count ? "created_replacement_github_issue" : "created_github_issue"), github_issue_url: $("Resolve Canonical GitHub Issue").item.json.canonical_github_issue_url, created_github_issue_url: $("Resolve Canonical GitHub Issue").item.json.created_github_issue_url, duplicate_created: $("Resolve Canonical GitHub Issue").item.json.duplicate_created, closed_github_issue_count: $("Resolve Canonical GitHub Issue").item.json.closed_github_issue_count || 0, plane_issue_id: $("Normalize Plane Payload").item.json.plane_issue_id } }}'),
      options: { responseCode: 200 }
    }
  }
});

const respondIgnored = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_not_ready", plane_state: $json.plane_state } }}'), options: { responseCode: 200 } } }
});

const respondDuplicate = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Existing Link', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "existing_open_github_issue", github_issue_url: $json.existing_github_issue_url, github_issue_number: $json.existing_github_issue_number || "" } }}'), options: { responseCode: 200 } } }
});

export default workflow('plane-ready-github-issue', 'Plane Ready to GitHub Issue')
  .add(planeWebhook)
  .to(config)
  .to(normalize)
  .to(isReady
    .onTrue(searchExistingGitHubIssues.to(detectExistingGitHubIssue).to(noExistingIssue
      .onTrue(createIssue.to(waitForGitHubIndex).to(searchCanonicalGitHubIssue).to(resolveCanonicalGitHubIssue).to(upsertIssueLock).to(duplicateCreated
        .onTrue(closeDuplicateIssue.to(commentPlane).to(respondCreated))
        .onFalse(commentPlane.to(respondCreated))))
      .onFalse(respondDuplicate)))
    .onFalse(respondIgnored));
`;

const prReviewWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const githubWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub PR Webhook', parameters: { httpMethod: 'POST', path: 'github-pr-review', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true } } }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [{ id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", slack_review_channel: "#workflow-builder", github_signature_validation: "pending-secret-credential", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_review_state_id: "0948b422-5c0c-4c37-b34d-0a358e156a6f", plane_review_state_name: "Review", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }] }
    }
  }
});

const extract = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract PR Review Context',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
const action = body.action || '';
const pr = body.pull_request || {};
const metadataText = [pr.body || '', pr.title || '', JSON.stringify(body)].join('\\\\n');
const issueUrl = metadataText.match(/https:\\\\/\\\\/github\\\\.com\\\\/[^\\\\s)]+\\\\/issues\\\\/\\\\d+/)?.[0] || '';
const planeUrl = metadataText.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const planeIssueId = metadataText.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const reviewable = ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
const message = [
  'Build ready for review',
  'Plane: ' + (planeUrl || planeIssueId || 'Not linked'),
  'GitHub Issue: ' + (issueUrl || 'Not linked'),
  'PR / Merge Link: ' + (pr.html_url || 'Not provided'),
  'Checks: pending or see GitHub PR',
  'Summary: ' + (pr.title || 'PR opened'),
  'Risks: See PR body',
  'Next step: review and merge in GitHub.'
].join('\\\\n');
return { json: { ...$json, config, action, reviewable, pr_title: pr.title, pr_url: pr.html_url, pr_merge_link: pr.html_url, issue_url: issueUrl, plane_url: planeUrl, plane_issue_id: planeIssueId, plane_state_id: config.plane_review_state_id, slack_message: message } };
\`
    }
  }
});

const shouldNotify = ifElse({
  version: 2.3,
  config: {
    name: 'Reviewable PR Action?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.reviewable) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const hasPlane = ifElse({
  version: 2.3,
  config: {
    name: 'Plane Task Linked?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.plane_issue_id }}'), operator: { type: 'string', operation: 'notEmpty' } }], combinator: 'and' }
    }
  }
});

const updatePlaneReview = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Move Plane to Review',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'PATCH',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.config.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { state: $json.plane_state_id } }}')
    }
  }
});

const commentPlaneReview = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Comment on Plane with PR Review Link',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ $("Extract PR Review Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Extract PR Review Context").item.json.config.plane_workspace_slug + "/projects/" + $("Extract PR Review Context").item.json.config.plane_project_id + "/work-items/" + $("Extract PR Review Context").item.json.plane_issue_id + "/comments/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { comment_html: "<p>PR ready for review: " + $("Extract PR Review Context").item.json.pr_url + "</p>", comment_json: {}, access: "INTERNAL", external_source: "github_pr", external_id: String(($("Extract PR Review Context").item.json.pr_url || "pr-review") + "-" + Date.now()) } }}')
    }
  }
});

const restoreReviewMessage = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Review Slack Message',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'slack-message', name: 'slack_message', type: 'string', value: expr('{{ $("Extract PR Review Context").item.json.slack_message }}') },
          { id: 'pr-url', name: 'pr_url', type: 'string', value: expr('{{ $("Extract PR Review Context").item.json.pr_url }}') }
        ]
      }
    }
  }
});

const slackReview = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Review Message',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#workflow-builder' },
      messageType: 'text',
      text: expr('{{ $json.slack_message }}'),
      otherOptions: { includeLinkToWorkflow: false, mrkdwn: true }
    }
  }
});

const respondNotified = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Notified', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "slack_review_sent", pr_url: $json.pr_url, plane_issue_id: $("Extract PR Review Context").item.json.plane_issue_id || "", plane_review_queued: Boolean($("Extract PR Review Context").item.json.plane_issue_id) } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_pr_action", github_action: $json.action } }}'), options: { responseCode: 200 } } } });

export default workflow('github-pr-slack-review', 'GitHub PR to Slack Review')
  .add(githubWebhook)
  .to(config)
  .to(extract)
  .to(shouldNotify
    .onTrue(hasPlane
      .onTrue(updatePlaneReview.to(commentPlaneReview).to(restoreReviewMessage).to(slackReview).to(respondNotified))
      .onFalse(slackReview.to(respondNotified)))
    .onFalse(respondIgnored));
`;

const prFeedbackWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const githubCommentWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub PR Feedback Webhook', parameters: { httpMethod: 'POST', path: 'github-pr-feedback', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true } } }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", slack_revision_channel: "#workflow-builder", revision_command: "/codex revise", github_signature_validation: "pending-secret-credential", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_in_progress_state_id: "57e8338f-7181-44f6-9f5e-806a425ec6b2", plane_in_progress_state_name: "In Progress", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }
        ]
      }
    }
  }
});

const extractFeedback = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Revision Feedback',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
const action = body.action || '';
const issue = body.issue || {};
const comment = body.comment || {};
const command = config.revision_command || '/codex revise';
const commentBody = String(comment.body || '');
const isPr = Boolean(issue.pull_request);
const commandMatched = commentBody.trim().toLowerCase().startsWith(command.toLowerCase());
const revisionRequest = commandMatched ? commentBody.trim().slice(command.length).trim() : '';
const prNumber = issue.number || '';
const valid = action === 'created' && isPr && commandMatched && Boolean(prNumber);
return {
  json: {
    ...$json,
    config,
    valid_revision_request: valid,
    github_action: action,
    pr_number: String(prNumber || ''),
    pr_url: issue.html_url || '',
    issue_body: issue.body || '',
    comment_url: comment.html_url || '',
    comment_author: comment.user?.login || '',
    revision_request: revisionRequest || 'No revision details provided.',
  },
};
\`
    }
  }
});

const shouldQueue = ifElse({
  version: 2.3,
  config: {
    name: 'Codex Revision Requested?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.valid_revision_request) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const fetchPr = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch PR Details',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/repos/" + $json.config.github_owner + "/" + $json.config.github_repo + "/pulls/" + $json.pr_number }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const resolveRevision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Revision Context',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const base = $('Extract Revision Feedback').item.json;
const pr = $json || {};
const text = [base.revision_request || '', base.issue_body || '', pr.body || '', pr.title || ''].join('\\\\n');
const planeIssueId = text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeUrl = text.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const prUrl = pr.html_url || base.pr_url || '';
const branch = pr.head?.ref || '';
const slackMessage = [
  'Codex revision requested',
  'PR: ' + (prUrl || 'not provided'),
  'Branch: ' + (branch || 'not resolved'),
  'Plane: ' + (planeUrl || planeIssueId || 'not resolved'),
  'Requested by: ' + (base.comment_author || 'unknown'),
  'Request: ' + base.revision_request,
  'Next: Codex should revise the PR branch and push an update.'
].join('\\\\n');
const githubAck = [
  'Codex revision queued.',
  '',
  planeIssueId ? 'Plane moved to In Progress.' : 'Plane metadata was not resolved; Plane update skipped.',
  '',
  'Revision request:',
  base.revision_request
].join('\\\\n');
return { json: { ...base, pr_title: pr.title || '', pr_url: prUrl, branch, plane_issue_id: planeIssueId, plane_url: planeUrl, slack_message: slackMessage, github_ack_body: githubAck, plane_state_id: base.config.plane_in_progress_state_id } };
\`
    }
  }
});

const hasPlane = ifElse({
  version: 2.3,
  config: {
    name: 'Plane Task Resolved?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.plane_issue_id }}'), operator: { type: 'string', operation: 'notEmpty' } }], combinator: 'and' }
    }
  }
});

const updatePlane = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Move Plane to In Progress',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'PATCH',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.config.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { state: $json.plane_state_id } }}')
    }
  }
});

const commentPlane = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Comment on Plane with Revision Request',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ $("Resolve Revision Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Resolve Revision Context").item.json.config.plane_workspace_slug + "/projects/" + $("Resolve Revision Context").item.json.config.plane_project_id + "/work-items/" + $("Resolve Revision Context").item.json.plane_issue_id + "/comments/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { comment_html: "<p>Revision requested from GitHub PR feedback.</p><p>PR: " + $("Resolve Revision Context").item.json.pr_url + "</p><p>Request: " + $("Resolve Revision Context").item.json.revision_request + "</p>", comment_json: {}, access: "INTERNAL", external_source: "github_pr_feedback", external_id: String($("Resolve Revision Context").item.json.comment_url || $("Resolve Revision Context").item.json.pr_url || "") } }}')
    }
  }
});

const restoreRevision = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Revision Notification',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'slack-message', name: 'slack_message', type: 'string', value: expr('{{ $("Resolve Revision Context").item.json.slack_message }}') },
          { id: 'github-ack', name: 'github_ack_body', type: 'string', value: expr('{{ $("Resolve Revision Context").item.json.github_ack_body }}') },
          { id: 'pr-url', name: 'pr_url', type: 'string', value: expr('{{ $("Resolve Revision Context").item.json.pr_url }}') },
          { id: 'pr-number', name: 'pr_number', type: 'string', value: expr('{{ $("Resolve Revision Context").item.json.pr_number }}') },
          { id: 'plane-issue-id', name: 'plane_issue_id', type: 'string', value: expr('{{ $("Resolve Revision Context").item.json.plane_issue_id }}') }
        ]
      }
    }
  }
});

const slackRevision = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Revision Request',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#workflow-builder' },
      messageType: 'text',
      text: expr('{{ $json.slack_message }}'),
      otherOptions: { includeLinkToWorkflow: false, mrkdwn: true }
    }
  }
});

const acknowledgeGitHub = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Acknowledge Revision on GitHub',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ "https://api.github.com/repos/" + $("Resolve Revision Context").item.json.config.github_owner + "/" + $("Resolve Revision Context").item.json.config.github_repo + "/issues/" + $("Resolve Revision Context").item.json.pr_number + "/comments" }}'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'githubApi',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { body: $("Resolve Revision Context").item.json.github_ack_body } }}')
    }
  }
});

const respondQueued = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Revision Queued', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "codex_revision_queued", pr_url: $("Resolve Revision Context").item.json.pr_url, plane_issue_id: $("Resolve Revision Context").item.json.plane_issue_id || "" } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_comment", github_action: $json.github_action } }}'), options: { responseCode: 200 } } } });

export default workflow('github-pr-feedback-revision-queue', 'GitHub PR Feedback to Codex Revision Queue')
  .add(githubCommentWebhook)
  .to(config)
  .to(extractFeedback)
  .to(shouldQueue
    .onTrue(fetchPr.to(resolveRevision).to(hasPlane
      .onTrue(updatePlane.to(commentPlane).to(restoreRevision).to(slackRevision).to(acknowledgeGitHub).to(respondQueued))
      .onFalse(restoreRevision.to(slackRevision).to(acknowledgeGitHub).to(respondQueued))))
    .onFalse(respondIgnored));
`;

const websiteCheckerWorkflow = `
import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const manual = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Manual Test Trigger'
  }
});

const testWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Website Checker Test Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'website-checker-test',
      responseMode: 'responseNode'
    }
  }
});

const schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: {
    name: 'Every 30 Minutes',
    parameters: {
      rule: {
        interval: [
          { field: 'minutes', minutesInterval: 30 }
        ]
      }
    }
  }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { website_url: "http://www.tciallc.com/", timeout_ms: 15000, slack_alert_channel: "#workflow-builder" } }}') }
        ]
      }
    }
  }
});

const checkWebsite = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Website',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const url = config.website_url || 'http://www.tciallc.com/';
const timeoutMs = Number(config.timeout_ms || 15000);
const startedAt = Date.now();
let result = {
  website_url: url,
  final_url: '',
  status: 0,
  status_text: '',
  duration_ms: 0,
  ok: false,
  error: '',
};

try {
  const response = await this.helpers.httpRequest({
    method: 'GET',
    url,
    timeout: timeoutMs,
    returnFullResponse: true,
    headers: {
      'user-agent': 'agentic-buildout-starter/n8n-website-checker',
    },
  });

  result = {
    ...result,
    final_url: response.request?.uri?.href || url,
    status: response.statusCode,
    status_text: response.statusMessage,
    duration_ms: Date.now() - startedAt,
    ok: response.statusCode >= 200 && response.statusCode < 400,
  };
} catch (error) {
  result = {
    ...result,
    duration_ms: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

const slackMessage = [
  'Website check failed',
  'URL: ' + result.website_url,
  'Status: ' + (result.status || 'request failed'),
  'Final URL: ' + (result.final_url || 'not reached'),
  'Duration: ' + result.duration_ms + 'ms',
  'Error: ' + (result.error || 'HTTP status outside 2xx/3xx')
].join('\\\\n');

return { json: { ...$json, ...result, slack_message: slackMessage } };
\`
    }
  }
});

const websiteUp = ifElse({
  version: 2.3,
  config: {
    name: 'Website is Up?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.ok) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const slackAlert = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Website Alert',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#workflow-builder' },
      messageType: 'text',
      text: expr('{{ $json.slack_message }}'),
      otherOptions: { includeLinkToWorkflow: false, mrkdwn: true }
    }
  }
});

const respondOk = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Website Up',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ { ok: true, action: "website_check_passed", website_url: $json.website_url, final_url: $json.final_url, status: $json.status, duration_ms: $json.duration_ms } }}'),
      options: { responseCode: 200 }
    }
  }
});

const respondAlerted = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Website Alerted',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ { ok: false, action: "website_check_failed", website_url: $json.website_url, status: $json.status, error: $json.error } }}'),
      options: { responseCode: 200 }
    }
  }
});

export default workflow('website-checker', 'Website Checker')
  .add(manual)
  .to(config)
  .add(testWebhook)
  .to(config)
  .add(schedule)
  .to(config)
  .to(checkWebsite)
  .to(websiteUp
    .onTrue(respondOk)
    .onFalse(slackAlert.to(respondAlerted)));
`;

const emailCategorizerWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const manual = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Manual Dry Run Trigger'
  }
});

const testWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Email Categorizer Test Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'email-categorizer-test',
      responseMode: 'responseNode'
    }
  }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { dry_run: true, enable_schedule_processing: false, enable_outlook_patch: false, batch_limit: 25, tier3_confidence_threshold: 0.65, slack_exception_channel: "#workflow-builder", audit_table: "inbox_classifications", ms_user_email: "dbradley@tciallc.com", classifier_mount_path: "/data/classifier", tier3_provider: "dbhub_ollama", local_llm_base_url: "http://100.66.221.24:11434", local_llm_model: "qwen2.5:7b", enable_tier3_local_llm: true, outlook_category_map: { Q1: "Q1: Do Now", Q2: "Q2: Schedule", Q3: "Q3: Delegate", Q4: "Q4: Eliminate", QR: "QR: Quarantine" }, readiness: { outlook_credential: "Microsoft Outlook account", postgres_credential: "pending", local_llm: "direct Ollama Tier 3 enabled for dry-run metadata classification" } } }}') }
        ]
      }
    }
  }
});

const listOutlookCategories = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Outlook Categories',
    credentials: { microsoftOutlookOAuth2Api: newCredential('Microsoft Outlook account', 'microsoftOutlookOAuth2Api') },
    parameters: {
      method: 'GET',
      url: expr('{{ "https://graph.microsoft.com/v1.0/users/" + $json.config.ms_user_email + "/outlook/masterCategories" }}'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'microsoftOutlookOAuth2Api',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }
    }
  }
});

const prepareOutlookRun = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Outlook Run',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $('CONFIG').item.json.config || {};
let webhook = {};
try {
  webhook = $('Email Categorizer Test Webhook').item.json || {};
} catch {}
const body = webhook.body || {};
const liveCategories = Array.isArray($json.value) ? $json.value : [];
const liveNames = liveCategories.map((item) => item.displayName || item.name || '').filter(Boolean);
const expected = Object.values(config.outlook_category_map || {});
const missing = expected.filter((label) => !liveNames.includes(label));
const readinessErrors = [];
if (missing.length) {
  readinessErrors.push('Missing Outlook categories: ' + missing.join(', '));
}
if (config.enable_outlook_patch) {
  readinessErrors.push('Live Outlook PATCH is still blocked by workflow design; keep enable_outlook_patch=false until dry-run audit is reviewed.');
}
if (config.enable_tier3_local_llm !== true) {
  readinessErrors.push('DBHub Ollama Tier 3 is disabled; low-confidence messages will remain unresolved.');
}
readinessErrors.push('Postgres audit credential is not configured in this workflow yet.');

return {
  json: {
    config,
    body,
    live_category_names: liveNames,
    category_map_ok: missing.length === 0,
    readiness_errors: readinessErrors,
    mode: Array.isArray(body.messages) ? 'webhook_dry_run' : 'outlook_metadata_dry_run'
  }
};
\`
    }
  }
});

const useProvidedMessages = ifElse({
  version: 2.3,
  config: {
    name: 'Use Provided Test Messages?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String(Array.isArray($json.body?.messages)) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const prepareProvidedMessages = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Provided Messages',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || {};
const fromWebhook = Array.isArray(body.messages) ? body.messages : [];
const manualSample = [
  {
    id: 'sample-q1',
    internetMessageId: '<sample-q1@example>',
    subject: 'Urgent client escalation - response needed today',
    from: { emailAddress: { address: 'client@example.com', name: 'Sample Client' } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    importance: 'high',
    hasAttachments: false,
    categories: []
  },
  {
    id: 'sample-q2',
    internetMessageId: '<sample-q2@example>',
    subject: 'Planning agenda for next week',
    from: { emailAddress: { address: 'ops@example.com', name: 'Ops' } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    importance: 'normal',
    hasAttachments: false,
    categories: []
  },
  {
    id: 'sample-qr',
    internetMessageId: '<sample-qr@example>',
    subject: 'Wire transfer invoice password reset crypto prize',
    from: { emailAddress: { address: 'alerts@suspicious.example', name: 'Suspicious Sender' } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    importance: 'normal',
    hasAttachments: true,
    categories: []
  }
];

const messages = fromWebhook.length ? fromWebhook : manualSample;
return {
  json: {
    ...$json,
    mode: fromWebhook.length ? 'webhook_dry_run' : 'sample_dry_run',
    messages: messages.slice(0, Number(config.batch_limit || 25))
  }
};
\`
    }
  }
});

const getUnreadUncategorized = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get Unread Uncategorized Outlook Metadata',
    credentials: { microsoftOutlookOAuth2Api: newCredential('Microsoft Outlook account', 'microsoftOutlookOAuth2Api') },
    parameters: {
      method: 'GET',
      url: expr('{{ "https://graph.microsoft.com/v1.0/users/" + $json.config.ms_user_email + "/mailFolders/inbox/messages?$top=" + Number($json.config.batch_limit || 25) + "&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,importance,hasAttachments,categories,isRead&$filter=isRead eq false" }}'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'microsoftOutlookOAuth2Api',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }
    }
  }
});

const normalizeOutlookMessages = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Outlook Metadata',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const prepared = $('Prepare Outlook Run').item.json;
const config = prepared.config || {};
const raw = Array.isArray($json.value) ? $json.value : [];
const messages = raw
  .filter((message) => !Array.isArray(message.categories) || message.categories.length === 0)
  .slice(0, Number(config.batch_limit || 25));

return {
  json: {
    ...prepared,
    mode: 'outlook_metadata_dry_run',
    fetched_unread_count: raw.length,
    skipped_already_categorized_count: raw.length - messages.length,
    messages
  }
};
\`
    }
  }
});

const classifyMessages = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Classify Metadata Dry Run',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const categoryMap = config.outlook_category_map || {};

function emailAddress(value) {
  return value?.emailAddress?.address || value?.address || '';
}

function classify(message) {
  const subject = String(message.subject || '').toLowerCase();
  const sender = emailAddress(message.from).toLowerCase();
  const importance = String(message.importance || '').toLowerCase();
  const hasAttachments = Boolean(message.hasAttachments);
  const suspicious = /(wire|crypto|password|gift card|prize|urgent payment|bank|invoice)/i.test(subject) && (hasAttachments || /suspicious|unknown|external/.test(sender));
  const urgent = /(urgent|asap|today|escalation|blocked|down|outage|deadline)/i.test(subject) || importance === 'high';
  const planning = /(plan|planning|schedule|agenda|strategy|roadmap|next week|follow up)/i.test(subject);
  const delegate = /(delegate|assign|handoff|review requested|please review)/i.test(subject);
  const lowValue = /(newsletter|unsubscribe|promo|sale|digest|webinar)/i.test(subject);

  if (suspicious) return { quadrant: 'QR', tier_fired: 1, confidence: 0.9, reason: 'Suspicious financial/security language from external or attachment-bearing message.' };
  if (urgent) return { quadrant: 'Q1', tier_fired: 1, confidence: 0.82, reason: 'Urgent/high-importance metadata indicates do-now work.' };
  if (planning) return { quadrant: 'Q2', tier_fired: 1, confidence: 0.78, reason: 'Planning/scheduling language indicates important non-urgent work.' };
  if (delegate) return { quadrant: 'Q3', tier_fired: 1, confidence: 0.74, reason: 'Review/delegation language indicates candidate for delegation.' };
  if (lowValue) return { quadrant: 'Q4', tier_fired: 1, confidence: 0.76, reason: 'Promotional or digest metadata indicates low-value work.' };
  return { quadrant: 'Q2', tier_fired: 0, confidence: 0.45, reason: 'No deterministic rule matched; DBHub Ollama Tier 3 should review this metadata.', needs_tier3: true };
}

const results = ($json.messages || []).map((message) => {
  const classification = classify(message);
  const label = categoryMap[classification.quadrant] || classification.quadrant;
  return {
    message_id: message.id || message.internetMessageId || '',
    internet_message_id: message.internetMessageId || '',
    subject: message.subject || '',
    from: emailAddress(message.from),
    received_at: message.receivedDateTime || '',
    importance: message.importance || '',
    has_attachments: Boolean(message.hasAttachments),
    existing_categories: Array.isArray(message.categories) ? message.categories : [],
    quadrant: classification.quadrant,
    outlook_category_label: label,
    tier_fired: classification.tier_fired,
    confidence: classification.confidence,
    needs_tier3: Boolean(classification.needs_tier3),
    tier3_provider: classification.needs_tier3 ? config.tier3_provider : '',
    tier3_status: classification.needs_tier3 ? (config.enable_tier3_local_llm ? 'queued_local_llm_call' : 'skipped_local_llm_disabled') : 'not_needed',
    dry_run: Boolean(config.dry_run),
    would_patch_outlook: Boolean(!config.dry_run && config.enable_outlook_patch),
    applied_ok: false,
    reason: classification.reason
  };
});

const tier3Messages = results
  .filter((item) => item.needs_tier3 && config.enable_tier3_local_llm === true)
  .map((item) => ({
    message_id: item.message_id,
    internet_message_id: item.internet_message_id,
    subject: item.subject,
    from: item.from,
    received_at: item.received_at,
    importance: item.importance,
    has_attachments: item.has_attachments
  }));
const exceptions = results.filter((item) => item.quadrant === 'QR' || (item.needs_tier3 && config.enable_tier3_local_llm !== true));
const slackMessage = [
  'Email categorizer dry-run exception summary',
  'Mode: ' + ($json.mode || 'unknown'),
  'Messages: ' + results.length,
  'Exceptions: ' + exceptions.length,
  'Dry run: ' + String(config.dry_run !== false),
  'Details: ' + exceptions.map((item) => item.message_id + ' -> ' + item.quadrant + ' (' + item.reason + ')').join('; ')
].join('\\\\n');

return {
  json: {
    ...$json,
    classification_results: results,
    tier3_messages: tier3Messages,
    exception_count: exceptions.length,
    has_exception: exceptions.length > 0,
    slack_message: slackMessage,
    live_category_names: $json.live_category_names || [],
    category_map_ok: Boolean($json.category_map_ok),
    fetched_unread_count: Number($json.fetched_unread_count || 0),
    skipped_already_categorized_count: Number($json.skipped_already_categorized_count || 0),
    audit_status: 'skipped_postgres_not_configured',
    outlook_patch_status: config.dry_run ? 'skipped_dry_run' : 'disabled_until_enable_outlook_patch_true'
  }
};
\`
    }
  }
});

const hasException = ifElse({
  version: 2.3,
  config: {
    name: 'Exception Notification Needed?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.has_exception) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const needsTier3Llm = ifElse({
  version: 2.3,
  config: {
    name: 'Needs Ollama Tier 3?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.config.enable_tier3_local_llm === true && Array.isArray($json.tier3_messages) && $json.tier3_messages.length > 0) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const ollamaTier3 = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'DBHub Ollama Tier 3 Metadata Classifier',
    parameters: {
      method: 'POST',
      url: expr('{{ $json.config.local_llm_base_url + "/api/chat" }}'),
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { model: $json.config.local_llm_model, stream: false, format: "json", messages: [{ role: "system", content: "You classify email metadata into Eisenhower categories. Use only the provided metadata. Do not infer from email bodies or attachments. Return strict JSON only." }, { role: "user", content: "Classify each message as one of Q1, Q2, Q3, Q4, or QR. Q1 means urgent and important. Q2 means important but not urgent. Q3 means urgent but delegable. Q4 means low-value or eliminate. QR means quarantine/security/spam risk. Return JSON: {\\\\\\"classifications\\\\\\":[{\\\\\\"message_id\\\\\\":\\\\\\"...\\\\\\",\\\\\\"quadrant\\\\\\":\\\\\\"Q1|Q2|Q3|Q4|QR\\\\\\",\\\\\\"confidence\\\\\\":0.0,\\\\\\"reason\\\\\\":\\\\\\"short reason\\\\\\"}]}. Messages: " + JSON.stringify($json.tier3_messages) }] } }}'),
      options: { timeout: 120000 }
    }
  }
});

const mergeTier3 = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Tier 3 Results',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Classify Metadata Dry Run').item.json;
const config = original.config || {};
const categoryMap = config.outlook_category_map || {};
const allowed = new Set(['Q1', 'Q2', 'Q3', 'Q4', 'QR']);

function parseJsonContent(content) {
  let text = String(content || '').trim();
  const fence = String.fromCharCode(96, 96, 96);
  if (text.toLowerCase().startsWith(fence + 'json')) {
    text = text.slice(7).trim();
  } else if (text.startsWith(fence)) {
    text = text.slice(3).trim();
  }
  if (text.endsWith(fence)) {
    text = text.slice(0, -3).trim();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { parse_error: error.message, raw: text.slice(0, 500) };
  }
}

const parsed = parseJsonContent($json.message?.content);
const rows = Array.isArray(parsed.classifications) ? parsed.classifications : [];
const byId = new Map(rows.map((row) => [String(row.message_id || ''), row]));

const results = (original.classification_results || []).map((item) => {
  if (!item.needs_tier3) return item;
  const row = byId.get(String(item.message_id || ''));
  const quadrant = String(row?.quadrant || '').toUpperCase();
  if (!row || !allowed.has(quadrant)) {
    return {
      ...item,
      tier3_status: parsed.parse_error ? 'failed_local_llm_parse' : 'failed_local_llm_missing_result',
      error_text: parsed.parse_error || 'Ollama did not return a valid classification for this message.',
    };
  }

  const confidence = Number(row.confidence);
  return {
    ...item,
    quadrant,
    outlook_category_label: categoryMap[quadrant] || quadrant,
    tier_fired: 3,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : item.confidence,
    needs_tier3: false,
    tier3_status: 'applied_local_llm',
    reason: String(row.reason || 'DBHub Ollama Tier 3 classified this metadata.').slice(0, 500),
    error_text: '',
  };
});

const exceptions = results.filter((item) => item.quadrant === 'QR' || item.needs_tier3 || /^failed_/.test(String(item.tier3_status || '')));
const slackMessage = [
  'Email categorizer dry-run exception summary',
  'Mode: ' + (original.mode || 'unknown'),
  'Messages: ' + results.length,
  'Exceptions: ' + exceptions.length,
  'Dry run: ' + String(config.dry_run !== false),
  'Details: ' + exceptions.map((item) => item.message_id + ' -> ' + item.quadrant + ' (' + (item.error_text || item.reason) + ')').join('; ')
].join('\\\\n');

return {
  json: {
    ...original,
    classification_results: results,
    exception_count: exceptions.length,
    has_exception: exceptions.length > 0,
    slack_message: slackMessage,
    tier3_raw_status: $json.done === true ? 'ollama_done' : 'ollama_unknown',
  }
};
\`
    }
  }
});

const slackException = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Exception',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#workflow-builder' },
      messageType: 'text',
      text: expr('{{ $json.slack_message }}'),
      otherOptions: { includeLinkToWorkflow: false, mrkdwn: true }
    }
  }
});

const restoreDryRunResult = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Dry Run Result',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'config', name: 'config', type: 'object', value: expr('{{ $("Classify Metadata Dry Run").item.json.config }}') },
          { id: 'mode', name: 'mode', type: 'string', value: expr('{{ $("Classify Metadata Dry Run").item.json.mode }}') },
          { id: 'results', name: 'classification_results', type: 'array', value: expr('{{ $("Classify Metadata Dry Run").item.json.classification_results }}') },
          { id: 'exception-count', name: 'exception_count', type: 'number', value: expr('{{ $("Classify Metadata Dry Run").item.json.exception_count }}') },
          { id: 'audit-status', name: 'audit_status', type: 'string', value: expr('{{ $("Classify Metadata Dry Run").item.json.audit_status }}') },
          { id: 'outlook-patch-status', name: 'outlook_patch_status', type: 'string', value: expr('{{ $("Classify Metadata Dry Run").item.json.outlook_patch_status }}') },
          { id: 'readiness-errors', name: 'readiness_errors', type: 'array', value: expr('{{ $("Classify Metadata Dry Run").item.json.readiness_errors }}') },
          { id: 'live-category-names', name: 'live_category_names', type: 'array', value: expr('{{ $("Classify Metadata Dry Run").item.json.live_category_names }}') },
          { id: 'category-map-ok', name: 'category_map_ok', type: 'boolean', value: expr('{{ $("Classify Metadata Dry Run").item.json.category_map_ok }}') },
          { id: 'fetched-unread-count', name: 'fetched_unread_count', type: 'number', value: expr('{{ $("Classify Metadata Dry Run").item.json.fetched_unread_count }}') },
          { id: 'skipped-categorized-count', name: 'skipped_already_categorized_count', type: 'number', value: expr('{{ $("Classify Metadata Dry Run").item.json.skipped_already_categorized_count }}') }
        ]
      }
    }
  }
});

const restoreTier3Result = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Tier 3 Result',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'config', name: 'config', type: 'object', value: expr('{{ $("Merge Tier 3 Results").item.json.config }}') },
          { id: 'mode', name: 'mode', type: 'string', value: expr('{{ $("Merge Tier 3 Results").item.json.mode }}') },
          { id: 'results', name: 'classification_results', type: 'array', value: expr('{{ $("Merge Tier 3 Results").item.json.classification_results }}') },
          { id: 'exception-count', name: 'exception_count', type: 'number', value: expr('{{ $("Merge Tier 3 Results").item.json.exception_count }}') },
          { id: 'audit-status', name: 'audit_status', type: 'string', value: expr('{{ $("Merge Tier 3 Results").item.json.audit_status }}') },
          { id: 'outlook-patch-status', name: 'outlook_patch_status', type: 'string', value: expr('{{ $("Merge Tier 3 Results").item.json.outlook_patch_status }}') },
          { id: 'readiness-errors', name: 'readiness_errors', type: 'array', value: expr('{{ $("Merge Tier 3 Results").item.json.readiness_errors }}') },
          { id: 'live-category-names', name: 'live_category_names', type: 'array', value: expr('{{ $("Merge Tier 3 Results").item.json.live_category_names }}') },
          { id: 'category-map-ok', name: 'category_map_ok', type: 'boolean', value: expr('{{ $("Merge Tier 3 Results").item.json.category_map_ok }}') },
          { id: 'fetched-unread-count', name: 'fetched_unread_count', type: 'number', value: expr('{{ $("Merge Tier 3 Results").item.json.fetched_unread_count }}') },
          { id: 'skipped-categorized-count', name: 'skipped_already_categorized_count', type: 'number', value: expr('{{ $("Merge Tier 3 Results").item.json.skipped_already_categorized_count }}') }
        ]
      }
    }
  }
});

const respondDryRun = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Dry Run Result',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ { ok: true, action: "email_categorizer_dry_run", mode: $json.mode, dry_run: $json.config.dry_run, mailbox: $json.config.ms_user_email, category_map_ok: $json.category_map_ok, live_category_names: $json.live_category_names, fetched_unread_count: $json.fetched_unread_count, skipped_already_categorized_count: $json.skipped_already_categorized_count, messages: $json.classification_results.length, exception_count: $json.exception_count, audit_status: $json.audit_status, outlook_patch_status: $json.outlook_patch_status, readiness_errors: $json.readiness_errors, results: $json.classification_results } }}'),
      options: { responseCode: 200 }
    }
  }
});

export default workflow('email-categorizer', 'Email Categorizer')
  .add(manual)
  .to(config)
  .to(listOutlookCategories)
  .to(prepareOutlookRun)
  .to(useProvidedMessages
    .onTrue(prepareProvidedMessages.to(classifyMessages).to(needsTier3Llm
      .onTrue(ollamaTier3.to(mergeTier3).to(hasException
        .onTrue(slackException.to(restoreTier3Result).to(respondDryRun))
        .onFalse(respondDryRun)))
      .onFalse(hasException
        .onTrue(slackException.to(restoreDryRunResult).to(respondDryRun))
        .onFalse(respondDryRun))))
    .onFalse(getUnreadUncategorized.to(normalizeOutlookMessages).to(classifyMessages).to(needsTier3Llm
      .onTrue(ollamaTier3.to(mergeTier3).to(hasException
        .onTrue(slackException.to(restoreTier3Result).to(respondDryRun))
        .onFalse(respondDryRun)))
      .onFalse(hasException
        .onTrue(slackException.to(restoreDryRunResult).to(respondDryRun))
        .onFalse(respondDryRun)))))
  .add(testWebhook)
  .to(config)
  .to(listOutlookCategories);
`;

const deploymentWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const githubWorkflowWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub Deployment Result Webhook', parameters: { httpMethod: 'POST', path: 'github-deploy-result', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true } } }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          {
            id: 'config-object',
            name: 'config',
            type: 'object',
            value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", github_repo_full_name: "choicedrum-crypto/agentic-buildout-starter", github_default_branch: "main", github_deploy_workflow_name: "Deploy After Merge", github_deploy_workflow_file: "deploy.yml", production_branch: "main", github_signature_validation: "pending-secret-credential", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_project_identifier: "TCIA", plane_deploying_state_id: "b3a0fb50-9ec4-4198-8def-c3f807be486a", plane_deploying_state_name: "Deploying", plane_review_state_id: "0948b422-5c0c-4c37-b34d-0a358e156a6f", plane_review_state_name: "Review", plane_done_state_id: "9e8cb223-ee5d-4d52-89fc-1c0ffa900e70", plane_done_state_name: "Done", plane_failed_state_id: "8ea8d880-15b2-4201-8fbc-358ba54e5b54", plane_failed_state_name: "Blocked", plane_comment_access: "INTERNAL", slack_deploy_channel: "#workflow-builder", public_n8n_base_url: "https://n8n.tradecredit.agency", deployment_webhook_path: "github-deploy-result", deployment_webhook_url: "https://n8n.tradecredit.agency/webhook/github-deploy-result" } }}')
          }
        ]
      }
    }
  }
});

const extract = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Deployment Context',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
const run = body.workflow_run || {};
const isDeployWorkflow = run.name === 'Deploy After Merge';
const completed = isDeployWorkflow && run.status === 'completed';
const started = isDeployWorkflow && run.status !== 'completed';
const success = run.conclusion === 'success';
const text = JSON.stringify(body);
const planeIssueId = text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/)?.[1] || '';
const planeUrl = text.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const prNumber = run.pull_requests?.[0]?.number || run.display_title?.match(/\\\\(#(\\\\d+)\\\\)/)?.[1] || run.head_commit?.message?.match(/\\\\(#(\\\\d+)\\\\)/)?.[1] || '';
const stateId = started ? config.plane_deploying_state_id : (success ? config.plane_done_state_id : config.plane_failed_state_id);
const message = [
  'Deployment ' + (started ? 'started' : (success ? 'succeeded' : 'failed')),
  'Repo: ' + (body.repository?.full_name || config.github_owner + '/' + config.github_repo),
  'Commit: ' + (run.head_sha || 'unknown'),
  'Run: ' + (run.html_url || 'not provided'),
  'Plane: ' + (planeUrl || planeIssueId || 'not resolved'),
  'Plane status update: ' + (planeIssueId ? (started ? 'Deploying queued' : 'queued') : 'skipped, Plane task not resolved')
].join('\\\\n');
return { json: { ...$json, config, is_deploy_workflow: isDeployWorkflow, completed, started, success, deployment_status: started ? 'started' : (success ? 'succeeded' : 'failed'), run_url: run.html_url, head_sha: run.head_sha, repository: body.repository?.full_name, pr_number: String(prNumber || ''), plane_issue_id: planeIssueId, plane_url: planeUrl, plane_state_id: stateId, slack_message: message } };
\`
    }
  }
});

const isCompletedDeploy = ifElse({
  version: 2.3,
  config: {
    name: 'Deploy Workflow Event?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.is_deploy_workflow) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const hasPlane = ifElse({
  version: 2.3,
  config: {
    name: 'Plane Task Resolved?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.plane_issue_id }}'), operator: { type: 'string', operation: 'notEmpty' } }], combinator: 'and' }
    }
  }
});

const hasPrNumber = ifElse({
  version: 2.3,
  config: {
    name: 'Merged PR Resolved?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.pr_number }}'), operator: { type: 'string', operation: 'notEmpty' } }], combinator: 'and' }
    }
  }
});

const fetchMergedPr = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Merged PR',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/repos/" + $json.config.github_owner + "/" + $json.config.github_repo + "/pulls/" + $json.pr_number }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const fetchPrsForCommit = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch PRs for Deploy Commit',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/repos/" + $json.config.github_owner + "/" + $json.config.github_repo + "/commits/" + $json.head_sha + "/pulls" }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const resolvePlaneContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Plane Context',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const base = $('Extract Deployment Context').item.json;
const value = $json || {};
const pr = Array.isArray(value) ? (value[0] || {}) : value;
const text = [
  base.plane_issue_id || '',
  base.plane_url || '',
  base.body?.workflow_run?.display_title || '',
  base.body?.workflow_run?.head_commit?.message || '',
  pr.title || '',
  pr.body || '',
].join('\\\\n');
const planeIssueId =
  base.plane_issue_id ||
  text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] ||
  text.match(/Plane ID:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] ||
  '';
const planeUrl = base.plane_url || text.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const prUrl = pr.html_url || (base.pr_number ? 'https://github.com/' + base.config.github_owner + '/' + base.config.github_repo + '/pull/' + base.pr_number : '');
const githubIssueNumber =
  text.match(new RegExp('issues/([0-9]+)', 'i'))?.[1] ||
  text.match(new RegExp('Related GitHub issue:[^#]*#([0-9]+)', 'i'))?.[1] ||
  text.match(new RegExp('GitHub issue:[^#]*#([0-9]+)', 'i'))?.[1] ||
  text.match(new RegExp('Fixes[^#]*#([0-9]+)', 'i'))?.[1] ||
  text.match(new RegExp('Closes[^#]*#([0-9]+)', 'i'))?.[1] ||
  '';
const message = [
  'Deployment ' + (base.success ? 'succeeded' : 'failed'),
  'Repo: ' + (base.repository || base.config.github_owner + '/' + base.config.github_repo),
  'Commit: ' + (base.head_sha || 'unknown'),
  'Run: ' + (base.run_url || 'not provided'),
  'PR: ' + (prUrl || 'not resolved from commit'),
  'Plane: ' + (planeUrl || planeIssueId || 'not resolved'),
  'Plane status update: ' + (planeIssueId ? 'queued' : 'skipped, Plane task not resolved'),
  'GitHub issue close: ' + (base.success && planeIssueId && githubIssueNumber ? '#' + githubIssueNumber + ' queued' : 'skipped')
].join('\\\\n');
return { json: { ...base, plane_issue_id: planeIssueId, plane_url: planeUrl, pr_url: prUrl, github_issue_number: String(githubIssueNumber || ''), github_issue_url: githubIssueNumber ? 'https://github.com/' + base.config.github_owner + '/' + base.config.github_repo + '/issues/' + githubIssueNumber : '', slack_message: message } };
\`
    }
  }
});

const updatePlane = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Update Plane Status',
    alwaysOutputData: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'PATCH',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.config.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { state: $json.plane_state_id } }}')
    }
  }
});

const commentPlaneDeployment = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Comment on Plane with Deployment Result',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ $("Resolve Plane Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Resolve Plane Context").item.json.config.plane_workspace_slug + "/projects/" + $("Resolve Plane Context").item.json.config.plane_project_id + "/work-items/" + $("Resolve Plane Context").item.json.plane_issue_id + "/comments/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { comment_html: "<p>Deployment " + $("Resolve Plane Context").item.json.deployment_status + ".</p><ul><li>GitHub Actions run: " + ($("Resolve Plane Context").item.json.run_url || "not provided") + "</li><li>Commit: " + ($("Resolve Plane Context").item.json.head_sha || "unknown") + "</li><li>PR: " + ($("Resolve Plane Context").item.json.pr_url || "not resolved") + "</li></ul>", comment_json: {}, access: $("Resolve Plane Context").item.json.config.plane_comment_access || "INTERNAL", external_source: "github_actions", external_id: String(($("Resolve Plane Context").item.json.head_sha || "deployment") + "-" + Date.now()) } }}')
    }
  }
});

const shouldCloseGitHubIssue = ifElse({
  version: 2.3,
  config: {
    name: 'Close GitHub Issue?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { leftValue: expr('{{ String($("Resolve Plane Context").item.json.success) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' },
          { leftValue: expr('{{ $("Resolve Plane Context").item.json.plane_issue_id }}'), operator: { type: 'string', operation: 'notEmpty' } },
          { leftValue: expr('{{ $("Resolve Plane Context").item.json.github_issue_number }}'), operator: { type: 'string', operation: 'notEmpty' } }
        ],
        combinator: 'and'
      }
    }
  }
});

const commentGitHubIssueCompleted = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Comment GitHub Issue Completed',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'createComment',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($("Resolve Plane Context").item.json.github_issue_number) }}'),
      body: expr('{{ "Completed by PR " + ($("Resolve Plane Context").item.json.pr_url || "not resolved") + ".\\\\n\\\\nDeployment succeeded: " + ($("Resolve Plane Context").item.json.run_url || "not provided") + "\\\\nCommit: " + ($("Resolve Plane Context").item.json.head_sha || "unknown") }}')
    }
  }
});

const closeGitHubIssueCompleted = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Close GitHub Issue Completed',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'edit',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($("Resolve Plane Context").item.json.github_issue_number) }}'),
      editFields: {
        state: 'closed',
        state_reason: 'completed'
      }
    }
  }
});

const restoreDeployMessage = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Deployment Slack Message',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'slack-message', name: 'slack_message', type: 'string', value: expr('{{ $("Resolve Plane Context").item.json.slack_message }}') },
          { id: 'deployment-status', name: 'deployment_status', type: 'string', value: expr('{{ $("Resolve Plane Context").item.json.deployment_status }}') },
          { id: 'github-issue-number', name: 'github_issue_number', type: 'string', value: expr('{{ $("Resolve Plane Context").item.json.github_issue_number || "" }}') }
        ]
      }
    }
  }
});

const slackDeploy = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Deployment Result',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#workflow-builder' },
      messageType: 'text',
      text: expr('{{ $json.slack_message }}'),
      otherOptions: { includeLinkToWorkflow: false, mrkdwn: true }
    }
  }
});

const respondSynced = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Synced', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "deployment_status_synced", deployment_status: $json.deployment_status } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_workflow_run" } }}'), options: { responseCode: 200 } } } });

export default workflow('deployment-result-plane-slack', 'Deployment Result to Plane and Slack')
  .add(githubWorkflowWebhook)
  .to(config)
  .to(extract)
  .to(isCompletedDeploy
    .onTrue(hasPrNumber
      .onTrue(fetchMergedPr.to(resolvePlaneContext).to(hasPlane
        .onTrue(updatePlane.to(commentPlaneDeployment).to(shouldCloseGitHubIssue
          .onTrue(commentGitHubIssueCompleted.to(closeGitHubIssueCompleted).to(restoreDeployMessage).to(slackDeploy).to(respondSynced))
          .onFalse(restoreDeployMessage.to(slackDeploy).to(respondSynced))))
        .onFalse(slackDeploy.to(respondSynced))))
      .onFalse(fetchPrsForCommit.to(resolvePlaneContext).to(hasPlane
        .onTrue(updatePlane.to(commentPlaneDeployment).to(shouldCloseGitHubIssue
          .onTrue(commentGitHubIssueCompleted.to(closeGitHubIssueCompleted).to(restoreDeployMessage).to(slackDeploy).to(respondSynced))
          .onFalse(restoreDeployMessage.to(slackDeploy).to(respondSynced))))
        .onFalse(slackDeploy.to(respondSynced)))))
    .onFalse(respondIgnored));
`;

let workflows = [
  {
    name: 'Plane Ready to GitHub Issue',
    workflowId: 'MZSkpKTSDbrhvRrI',
    legacyQuery: 'plane-ready-to-github-issue.spec',
    code: planeReadyWorkflow,
    description: 'Receives Plane Ready webhooks, creates a Codex-ready GitHub issue, and comments the GitHub link back to Plane.',
  },
  {
    name: 'GitHub PR to Slack Review',
    workflowId: 'MO6tY2Q6ASh3OG7c',
    code: prReviewWorkflow,
    description: 'Receives GitHub PR webhooks and posts a Slack review message with the PR merge link.',
  },
  {
    name: 'Deployment Result to Plane and Slack',
    workflowId: 'dGC6BUgoR9ZlqtAr',
    code: deploymentWorkflow,
    description: 'Receives GitHub deployment workflow results, updates Plane status when resolved, and notifies Slack.',
  },
  {
    name: 'GitHub PR Feedback to Codex Revision Queue',
    workflowId: 'Vjt6XjFa84cHbs7B',
    code: prFeedbackWorkflow,
    description: 'Receives /codex revise PR comments, moves Plane back to In Progress, and notifies Slack that Codex should revise the PR branch.',
  },
  {
    name: 'Website Checker',
    workflowId: '6B5ORkypKRcbX0YX',
    code: websiteCheckerWorkflow,
    description: 'Runs an n8n scheduled website availability check for http://www.tciallc.com/ and alerts Slack when it fails.',
  },
  {
    name: 'Email Categorizer',
    workflowId: 'KeM4JZWK01qt532V',
    code: emailCategorizerWorkflow,
    description: 'Dry-run-first Outlook Eisenhower classifier workflow with safe test webhook and production activation gates.',
    verifyContains: ['dbradley@tciallc.com', 'Get Unread Uncategorized Outlook Metadata', 'dbhub_ollama', 'DBHub Ollama Tier 3 Metadata Classifier'],
    createAndSwap: true,
  },
];

const validateOnly = process.argv.includes('--validate-only');
const onlyIndex = process.argv.indexOf('--only');
if (onlyIndex !== -1) {
  const requestedName = process.argv[onlyIndex + 1];
  workflows = workflows.filter((item) => item.name === requestedName);
  if (workflows.length === 0) {
    throw new Error(`No workflow matched --only ${requestedName}`);
  }
}

await mcp('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'codex-local', version: '1.0.0' },
});

for (const item of workflows) {
  const validation = await tool('validate_workflow', { code: item.code });
  const validationContent = getStructuredContent(validation);
  if (validationContent.valid === false) {
    console.log(JSON.stringify(validation, null, 2));
    throw new Error(`Validation failed for ${item.name}`);
  }

  if (validateOnly) {
    console.log(`validated ${item.name}`);
    continue;
  }

  if (item.createAndSwap) {
    const publishToken = (env.GITHUB_SHA || new Date().toISOString()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const publishedName = `${item.name} - Published ${publishToken}`;
    const publishedCode = item.code.replace(
      `workflow('email-categorizer', 'Email Categorizer')`,
      `workflow('email-categorizer', '${publishedName}')`,
    );
    const exact = await tool('search_workflows', { query: item.name, limit: 20 });
    const matches = getStructuredContent(exact).data || [];
    const previousMatches = matches.filter(
      (workflowItem) =>
        workflowItem.id &&
        (workflowItem.name === item.name || workflowItem.name.startsWith(`${item.name} - Published `)),
    );

    for (const workflowItem of previousMatches) {
      try {
        await tool('unpublish_workflow', { workflowId: workflowItem.id });
      } catch (error) {
        console.warn(`could not unpublish ${item.name} (${workflowItem.id}) before archive: ${error.message}`);
      }
      await tool('archive_workflow', { workflowId: workflowItem.id });
      console.log(`archived previous ${item.name} (${workflowItem.id})`);
    }

    const created = await tool('create_workflow_from_code', {
      code: publishedCode,
      name: publishedName,
      description: item.description,
    });
    const createdContent = getStructuredContent(created);
    let createdWorkflowId = createdContent.workflow?.id || createdContent.workflowId || createdContent.id;
    if (!createdWorkflowId) {
      console.warn(`create_workflow_from_code returned no workflow ID for ${publishedName}; searching by exact name`);
      createdWorkflowId = (await findWorkflowByName(publishedName))?.id;
    }
    if (!createdWorkflowId) {
      console.log(JSON.stringify(created, null, 2));
      throw new Error(`Create-and-swap did not return a workflow ID for ${item.name}`);
    }

    if (item.verifyContains?.length) {
      const details = await tool('get_workflow_details', { workflowId: createdWorkflowId });
      const text = JSON.stringify(getStructuredContent(details));
      const missing = item.verifyContains.filter((marker) => !text.includes(marker));
      if (missing.length) {
        await tool('archive_workflow', { workflowId: createdWorkflowId });
        throw new Error(`Created ${item.name} candidate is missing expected markers: ${missing.join(', ')}`);
      }
    }

    await tool('publish_workflow', { workflowId: createdWorkflowId });

    console.log(`created-and-swapped ${item.name} as ${publishedName} (${createdWorkflowId})`);
    continue;
  }

  const exact = await tool('search_workflows', { query: item.name, limit: 20 });
  let existing = item.workflowId
    ? { id: item.workflowId, name: item.name }
    : getStructuredContent(exact).data?.find((workflowItem) => workflowItem.name === item.name);
  let legacyExisting;

  if (!existing && item.legacyQuery) {
    const legacy = await tool('search_workflows', { query: item.legacyQuery, limit: 20 });
    legacyExisting = getStructuredContent(legacy).data?.find((workflowItem) => workflowItem.name === item.legacyQuery);
  }

  if (existing) {
    await tool('unpublish_workflow', { workflowId: existing.id });
    const updated = await tool('update_workflow', {
      workflowId: existing.id,
      code: item.code,
      name: item.name,
      description: item.description,
    });
    const updatedContent = getStructuredContent(updated);
    if (updatedContent.hint || updatedContent.error) {
      console.log(JSON.stringify(updated, null, 2));
      throw new Error(`Update failed or did not confirm ${item.name} (${existing.id})`);
    }
    await tool('publish_workflow', { workflowId: existing.id });
    if (item.verifyContains?.length) {
      const details = await tool('get_workflow_details', { workflowId: existing.id });
      const text = JSON.stringify(getStructuredContent(details));
      const missing = item.verifyContains.filter((marker) => !text.includes(marker));
      if (missing.length) {
        throw new Error(`Published ${item.name} is missing expected markers: ${missing.join(', ')}`);
      }
    }
    console.log(`updated ${item.name} (${existing.id})`);
  } else {
    const created = await tool('create_workflow_from_code', {
      code: item.code,
      name: item.name,
      description: item.description,
    });
    const createdContent = getStructuredContent(created);
    const workflowId = createdContent.workflow?.id || createdContent.id || 'unknown';
    if (workflowId !== 'unknown') {
      await tool('publish_workflow', { workflowId });
    }
    console.log(`created ${item.name} (${workflowId})`);

    if (legacyExisting) {
      await tool('archive_workflow', { workflowId: legacyExisting.id });
      console.log(`archived legacy workflow ${legacyExisting.name} (${legacyExisting.id})`);
    }
  }
}
