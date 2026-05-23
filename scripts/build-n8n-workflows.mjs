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
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_project_identifier: "TCIA", plane_ready_state_id: "372009ad-e7bc-4639-9390-5540a123e435", plane_ready_state_name: "Ready", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }
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
      jsonBody: expr('{{ { comment_html: "<p>GitHub issue created: " + $json.html_url + "</p>", comment_json: {}, access: "INTERNAL", external_source: "github", external_id: String($json.number || "") } }}')
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
      responseBody: expr('{{ { ok: true, action: "created_github_issue", github_issue_url: $("Create GitHub Issue").item.json.html_url, plane_issue_id: $("Normalize Plane Payload").item.json.plane_issue_id } }}'),
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
  config: { name: 'Respond Existing Link', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "existing_github_issue", github_issue_url: $json.existing_github_issue_url } }}'), options: { responseCode: 200 } } }
});

export default workflow('plane-ready-github-issue', 'Plane Ready to GitHub Issue')
  .add(planeWebhook)
  .to(config)
  .to(normalize)
  .to(isReady
    .onTrue(noExistingIssue
      .onTrue(createIssue.to(commentPlane).to(respondCreated))
      .onFalse(respondDuplicate))
    .onFalse(respondIgnored));
`;

const prReviewWorkflow = `
import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const githubWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub PR Webhook', parameters: { httpMethod: 'POST', path: 'github-pr-review', authentication: 'none', responseMode: 'responseNode' } }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [{ id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", slack_review_channel: "#workflow-builder", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }] }
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
const issueUrl = (pr.body || '').match(/https:\\\\/\\\\/github\\\\.com\\\\/[^\\\\s)]+\\\\/issues\\\\/\\\\d+/)?.[0] || '';
const planeUrl = (pr.body || '').match(/https?:\\\\/\\\\/[^\\\\s)]+plane[^\\\\s)]*/i)?.[0] || '';
const reviewable = ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
const message = [
  'Build ready for review',
  'Plane: ' + (planeUrl || 'Not linked'),
  'GitHub Issue: ' + (issueUrl || 'Not linked'),
  'PR / Merge Link: ' + (pr.html_url || 'Not provided'),
  'Checks: pending or see GitHub PR',
  'Summary: ' + (pr.title || 'PR opened'),
  'Risks: See PR body',
  'Next step: review and merge in GitHub.'
].join('\\\\n');
return { json: { ...$json, config, action, reviewable, pr_title: pr.title, pr_url: pr.html_url, pr_merge_link: pr.html_url, issue_url: issueUrl, plane_url: planeUrl, slack_message: message } };
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

const respondNotified = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Notified', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "slack_review_sent", pr_url: $json.pr_url } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_pr_action", github_action: $json.action } }}'), options: { responseCode: 200 } } } });

export default workflow('github-pr-slack-review', 'GitHub PR to Slack Review')
  .add(githubWebhook)
  .to(config)
  .to(extract)
  .to(shouldNotify.onTrue(slackReview.to(respondNotified)).onFalse(respondIgnored));
`;

const deploymentWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const githubWorkflowWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub Deployment Result Webhook', parameters: { httpMethod: 'POST', path: 'github-deploy-result', authentication: 'none', responseMode: 'responseNode' } }
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
            value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", github_repo_full_name: "choicedrum-crypto/agentic-buildout-starter", github_default_branch: "main", github_deploy_workflow_name: "Deploy After Merge", github_deploy_workflow_file: "deploy.yml", production_branch: "main", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_project_id: "a0edb37d-263d-40c0-a34b-f77bbe9ba85d", plane_project_identifier: "TCIA", plane_done_state_id: "9e8cb223-ee5d-4d52-89fc-1c0ffa900e70", plane_done_state_name: "Done", plane_failed_state_id: "8ea8d880-15b2-4201-8fbc-358ba54e5b54", plane_failed_state_name: "Blocked", plane_comment_access: "INTERNAL", slack_deploy_channel: "#workflow-builder", public_n8n_base_url: "https://n8n.tradecredit.agency", deployment_webhook_path: "github-deploy-result", deployment_webhook_url: "https://n8n.tradecredit.agency/webhook/github-deploy-result" } }}')
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
const completed = run.name === 'Deploy After Merge' && run.status === 'completed';
const success = run.conclusion === 'success';
const text = JSON.stringify(body);
const planeIssueId = text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/)?.[1] || '';
const planeUrl = text.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const stateId = success ? config.plane_done_state_id : config.plane_failed_state_id;
const message = [
  'Deployment ' + (success ? 'succeeded' : 'failed'),
  'Repo: ' + (body.repository?.full_name || config.github_owner + '/' + config.github_repo),
  'Commit: ' + (run.head_sha || 'unknown'),
  'Run: ' + (run.html_url || 'not provided'),
  'Plane: ' + (planeUrl || planeIssueId || 'not resolved'),
  'Plane status update: ' + (planeIssueId ? 'queued' : 'skipped, Plane task not resolved')
].join('\\\\n');
return { json: { ...$json, config, completed, success, deployment_status: success ? 'succeeded' : 'failed', run_url: run.html_url, head_sha: run.head_sha, repository: body.repository?.full_name, plane_issue_id: planeIssueId, plane_url: planeUrl, plane_state_id: stateId, slack_message: message } };
\`
    }
  }
});

const isCompletedDeploy = ifElse({
  version: 2.3,
  config: {
    name: 'Deploy Workflow Completed?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.completed) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
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
          { id: 'slack-message', name: 'slack_message', type: 'string', value: expr('{{ $("Extract Deployment Context").item.json.slack_message }}') },
          { id: 'deployment-status', name: 'deployment_status', type: 'string', value: expr('{{ $("Extract Deployment Context").item.json.deployment_status }}') }
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
    .onTrue(hasPlane
      .onTrue(updatePlane.to(restoreDeployMessage).to(slackDeploy).to(respondSynced))
      .onFalse(slackDeploy.to(respondSynced)))
    .onFalse(respondIgnored));
`;

let workflows = [
  {
    name: 'Plane Ready to GitHub Issue',
    legacyQuery: 'plane-ready-to-github-issue.spec',
    code: planeReadyWorkflow,
    description: 'Receives Plane Ready webhooks, creates a Codex-ready GitHub issue, and comments the GitHub link back to Plane.',
  },
  {
    name: 'GitHub PR to Slack Review',
    code: prReviewWorkflow,
    description: 'Receives GitHub PR webhooks and posts a Slack review message with the PR merge link.',
  },
  {
    name: 'Deployment Result to Plane and Slack',
    code: deploymentWorkflow,
    description: 'Receives GitHub deployment workflow results, updates Plane status when resolved, and notifies Slack.',
  },
];

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
  if (validation.structuredContent?.valid === false) {
    console.log(JSON.stringify(validation, null, 2));
    throw new Error(`Validation failed for ${item.name}`);
  }

  const exact = await tool('search_workflows', { query: item.name, limit: 20 });
  let existing = exact.structuredContent?.data?.find((workflowItem) => workflowItem.name === item.name);
  let legacyExisting;

  if (!existing && item.legacyQuery) {
    const legacy = await tool('search_workflows', { query: item.legacyQuery, limit: 20 });
    legacyExisting = legacy.structuredContent?.data?.find((workflowItem) => workflowItem.name === item.legacyQuery);
  }

  if (existing) {
    await tool('update_workflow', {
      workflowId: existing.id,
      code: item.code,
      name: item.name,
      description: item.description,
    });
    console.log(`updated ${item.name} (${existing.id})`);
  } else {
    const created = await tool('create_workflow_from_code', {
      code: item.code,
      name: item.name,
      description: item.description,
    });
    const workflowId = created.structuredContent?.workflow?.id || created.structuredContent?.id || 'unknown';
    console.log(`created ${item.name} (${workflowId})`);

    if (legacyExisting) {
      await tool('archive_workflow', { workflowId: legacyExisting.id });
      console.log(`archived legacy workflow ${legacyExisting.name} (${legacyExisting.id})`);
    }
  }
}
