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

async function n8nApi(method, path, body) {
  const baseUrl = (env.N8N_REST_BASE_URL || `${env.N8N_PUBLIC_URL || 'https://n8n.tradecredit.agency'}/api/v1`).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-N8N-API-KEY': env.N8N_REST_API_KEY || env.N8N_API_KEY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`n8n API ${method} ${path} failed with ${response.status}: ${text}`);
  }
  return payload;
}

function buildEmailCategorizerRestWorkflow(name) {
  const enablePostgresAudit = env.EMAIL_CATEGORIZER_ENABLE_POSTGRES_AUDIT === 'true';
  const config = {
    ms_user_email: 'dbradley@tciallc.com',
    dry_run: false,
    enable_schedule_processing: true,
    batch_limit: 10,
    tier3_confidence_threshold: 0.65,
    slack_exception_channel: '#workflow-builder',
    audit_table: 'inbox_classifications',
    manual_correction_table: 'inbox_classification_corrections',
    enable_postgres_audit: enablePostgresAudit,
    postgres_credential_name: 'Email Categorizer Postgres',
  workflow_version: name,
    tier3_provider: 'dbhub_ollama',
    local_llm_base_url: 'http://100.66.221.24:11434',
    local_llm_model: 'qwen2.5:7b',
    enable_tier3_local_llm: true,
    enable_outlook_patch: true,
    outlook_category_map: {
      Q1: 'Q1: Do Now',
      Q2: 'Q2: Schedule',
      Q3: 'Q3: Delegate',
      Q4: 'Q4: Eliminate',
      QR: 'QR: Quarantine',
    },
  };

  const classifyCode = String.raw`
const config = $json.config || {};
const body = $json.body || $json;
const supplied = Array.isArray(body.messages) ? body.messages : [];
const outlookMessages = Array.isArray($json.messages) ? $json.messages : [];
const messages = supplied.length
  ? supplied
  : outlookMessages.length
    ? outlookMessages
    : [{
      id: 'sample-1',
      internetMessageId: '<sample-1@dry-run>',
      subject: 'Urgent customer credit hold escalation',
      from: { emailAddress: { address: 'sample@example.com' } },
      receivedDateTime: new Date().toISOString(),
      importance: 'high',
      hasAttachments: false,
      categories: [],
      isRead: false,
    }];

function addressOf(value) {
  return value?.emailAddress?.address || value?.address || value || '';
}

function deterministic(message) {
  const subject = String(message.subject || '').toLowerCase();
  const sender = addressOf(message.from).toLowerCase();
  const domain = sender.split('@').pop() || '';
  if (
    /github\.com$/.test(sender) &&
    /\b(run failed|workflow failed|check suite failed|deploy after merge)\b/.test(subject)
  ) {
    return { quadrant: 'Q4', confidence: 0.86, tier_fired: 2, reason: 'GitHub Actions failure notification is low-value automation noise for this mailbox.' };
  }
  if (/(urgent|asap|past due|overdue|suspension|credit hold|escalat|blocked|outage|deadline)/.test(subject) || message.importance === 'high') {
    return { quadrant: 'Q1', confidence: 0.84, tier_fired: 2, reason: 'Urgent, blocked, overdue, or high-importance metadata.' };
  }
  if (/(indication request|policy|euler hermes|atradius|aig|liberty|ach set ?up|monthly reporting|sales declaration|approved coverage|coverage|credit insurance|proposal|follow up|review|tristar|payment|invoice|statement|autopay|payment reminder|money|renewal|appointment|meeting|schedule|agenda|planning)/.test(subject) || /(atradius\.com|aig\.com|libertymutual\.com|vpracingfuels\.com)$/.test(domain)) {
    return { quadrant: 'Q2', confidence: 0.82, tier_fired: 2, reason: 'Business credit, insurance, finance, appointment, or follow-up metadata worth scheduling.' };
  }
  if (/(automatic reply|property sold|neighborhood alert|conference|now live|cooler, calmer home|plex pass|newsletter|unsubscribe|promotion|promo|discount|digest|webinar)/.test(subject) || /(neighborhoodalerts\.com|m\.plex\.tv|gie\.net|connect\.fergusonhome\.com|email\.openai\.com|amazon\.com|acquisition\.com)$/.test(domain) || /no-reply|noreply/.test(sender)) {
    return { quadrant: 'Q4', confidence: 0.84, tier_fired: 2, reason: 'Low-value alert, pricing, digest, or promotional metadata.' };
  }
  return { quadrant: 'QR', confidence: 0.4, tier_fired: 2, reason: 'Needs local LLM metadata review.' };
}

const baseResults = messages.map((message, index) => {
  const messageId = message.id || message.internetMessageId || 'message-' + (index + 1);
  return {
    message_id: messageId,
    tier3_key: 'm' + index,
    internetMessageId: message.internetMessageId || null,
    subject: message.subject || '',
    from: addressOf(message.from),
    receivedDateTime: message.receivedDateTime || null,
    importance: message.importance || 'normal',
    hasAttachments: Boolean(message.hasAttachments),
    categories: Array.isArray(message.categories) ? message.categories : [],
    ...deterministic(message),
  };
});

const needsTier3 = baseResults.filter((result) => result.confidence < config.tier3_confidence_threshold);

return [{
  json: {
    config,
    mode: supplied.length ? 'provided_messages' : outlookMessages.length ? (config.dry_run ? 'outlook_metadata_dry_run' : 'outlook_metadata_live') : 'sample',
    fetched_unread_count: Number($json.fetched_unread_count || 0),
    skipped_already_categorized_count: Number($json.skipped_already_categorized_count || 0),
    base_results: baseResults,
    needs_tier3_count: needsTier3.length,
    ollama_request: {
      model: config.local_llm_model,
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content: 'Classify email metadata into Q1, Q2, Q3, Q4, or QR. Return strict JSON only: {"results":[{"key":"m0","quadrant":"Q1","confidence":0.0,"reason":"..."}]}. Echo the short key exactly.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            allowed_quadrants: ['Q1', 'Q2', 'Q3', 'Q4', 'QR'],
            messages: needsTier3.map((result) => ({
              key: result.tier3_key,
              subject: result.subject,
              from: result.from,
              receivedDateTime: result.receivedDateTime,
              importance: result.importance,
              hasAttachments: result.hasAttachments,
            })),
          }),
        },
      ],
    },
  },
}];
`;

  const normalizeOutlookCode = String.raw`
const configInput = $('CONFIG').item.json || {};
const raw = Array.isArray($json.value) ? $json.value : [];
const messages = raw
  .filter((message) => !Array.isArray(message.categories) || message.categories.length === 0)
  .slice(0, Number(configInput.config?.batch_limit || 25));

return [{
  json: {
    ...configInput,
    mode: configInput.config?.dry_run ? 'outlook_metadata_dry_run' : 'outlook_metadata_live',
    fetched_unread_count: raw.length,
    skipped_already_categorized_count: raw.length - messages.length,
    messages,
  },
}];
`;

  const mergeOllamaCode = String.raw`
const config = $('CONFIG').item.json.config || {};
const prepared = $('Prepare Dry Run Classification').item.json;
const baseResults = prepared.base_results || [];
const needsTier3Count = Number(prepared.needs_tier3_count || 0);
let tier3Status = needsTier3Count ? 'applied_local_llm' : 'skipped';
let tier3Error = null;
let tier3Results = [];

if (needsTier3Count) {
  try {
    const content = String($json.message?.content || '{}').trim();
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      throw new Error('Ollama response did not include a JSON object');
    }
    const jsonText = content.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonText);
    const arrayCandidate =
      parsed.results ||
      parsed.classifications ||
      parsed.result ||
      parsed.classification ||
      parsed.messages ||
      parsed.items;
    if (Array.isArray(arrayCandidate)) {
      tier3Results = arrayCandidate;
    } else if (arrayCandidate && typeof arrayCandidate === 'object') {
      tier3Results = Object.entries(arrayCandidate).map(([key, value]) => ({ key, ...(value || {}) }));
    } else if (parsed && typeof parsed === 'object') {
      const objectRows = Object.entries(parsed)
        .filter(([, value]) => value && typeof value === 'object' && (value.quadrant || value.category))
        .map(([key, value]) => ({ key, ...value }));
      tier3Results = objectRows.length ? objectRows : [];
    }
  } catch (error) {
    tier3Status = 'failed_local_llm';
    tier3Error = error.message;
  }
}

const allowed = new Set(['Q1', 'Q2', 'Q3', 'Q4', 'QR']);
const byKey = new Map();
for (const result of tier3Results) {
  for (const key of [result.key, result.message_id, result.internet_message_id]) {
    if (key) byKey.set(String(key), result);
  }
}
let tier3OrderIndex = 0;
const results = baseResults.map((result) => {
  if (result.confidence >= config.tier3_confidence_threshold || !needsTier3Count) {
    return { ...result, tier3_status: 'skipped', error_text: null };
  }

  let tier3 =
    byKey.get(String(result.tier3_key || '')) ||
    byKey.get(String(result.message_id || '')) ||
    byKey.get(String(result.internetMessageId || ''));
  if (!tier3 && tier3Results.length === needsTier3Count) {
    tier3 = tier3Results[tier3OrderIndex];
  }
  tier3OrderIndex += 1;
  const quadrant = String(tier3?.quadrant || tier3?.category || tier3?.label || '').toUpperCase().replace(/^.*(Q[1-4]|QR).*$/, '$1');
  if (!tier3 || !allowed.has(quadrant)) {
    const missingError = !tier3
      ? 'Ollama did not return a matching key for this message.'
      : 'Ollama returned an invalid quadrant for this message.';
    return {
      ...result,
      tier3_status: 'failed_local_llm_missing_result',
      error_text: tier3Error || missingError,
    };
  }
  return {
    ...result,
    quadrant,
    confidence: Number(tier3.confidence || result.confidence),
    tier_fired: 3,
    reason: tier3.reason || result.reason,
    tier3_status: tier3Status,
    error_text: tier3Error,
  };
});
const now = new Date().toISOString();
  const auditRows = results.map((result) => ({
  classified_at: now,
  message_id: result.message_id,
  internet_message_id: result.internetMessageId || null,
  subject: result.subject,
  sender: result.from,
  sender_domain: String(result.from || '').split('@').pop() || null,
  received_at: result.receivedDateTime,
  importance: result.importance,
  has_attachments: result.hasAttachments,
  original_categories: result.categories,
  quadrant: result.quadrant,
  outlook_category_label: config.outlook_category_map[result.quadrant] || result.quadrant,
  tier_fired: result.tier_fired,
  confidence: result.confidence,
  rule_matched: result.tier_fired === 3 ? null : result.reason,
  llm_rationale: result.tier_fired === 3 ? result.reason : null,
  dry_run: config.dry_run,
  applied_ok: false,
  workflow_version: config.workflow_version,
  error_text: result.error_text,
}));

return [{
  json: {
    ok: true,
    action: config.dry_run ? 'email_categorizer_dry_run' : 'email_categorizer_live',
    mode: prepared.mode,
    dry_run: config.dry_run,
    mailbox: config.ms_user_email,
    fetched_unread_count: Number(prepared.fetched_unread_count || 0),
    skipped_already_categorized_count: Number(prepared.skipped_already_categorized_count || 0),
    tier3_provider: config.tier3_provider,
    tier3_status: tier3Status,
    local_llm_base_url: config.local_llm_base_url,
    local_llm_model: config.local_llm_model,
    messages: results.length,
    outlook_patch_status: config.dry_run ? 'skipped_dry_run' : 'pending_outlook_patch',
    audit_status: config.enable_postgres_audit ? 'pending_postgres_insert' : 'prepared_postgres_pending_credential',
    audit_table: config.audit_table,
    audit_rows: auditRows,
    results,
  },
}];
`;

  const prepareAuditInsertCode = String.raw`
const response = $('Merge DBHub Ollama Result').item.json;
const rows = response.audit_rows || [];
if (!rows.length) {
  return [{ json: { response: { ...response, audit_status: 'skipped_no_audit_rows', audit_insert_count: 0 }, query: 'select null::int as id' } }];
}

function sql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function sqlJson(value) {
  return sql(JSON.stringify(value || [])) + '::jsonb';
}

function sqlBool(value) {
  return value ? 'true' : 'false';
}

function sqlNumber(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : 'NULL';
}

return rows.map((row) => {
  const values = [
    sql(row.classified_at) + '::timestamptz',
    sql(row.message_id),
    sql(row.internet_message_id),
    sql(row.subject),
    sql(row.sender),
    sql(row.sender_domain),
    sql(row.received_at) + '::timestamptz',
    sql(row.importance),
    sqlBool(row.has_attachments),
    sqlJson(row.original_categories),
    sql(row.quadrant),
    sql(row.outlook_category_label),
    sqlNumber(row.tier_fired),
    sqlNumber(row.confidence),
    sql(row.rule_matched),
    sql(row.llm_rationale),
    sqlBool(row.dry_run),
    sqlBool(row.applied_ok),
    sql(row.workflow_version),
    sql(row.error_text),
  ];

  return {
    json: {
      query: [
        'insert into inbox_classifications (',
        'classified_at, message_id, internet_message_id, subject, sender, sender_domain,',
        'received_at, importance, has_attachments, original_categories, quadrant, outlook_category_label,',
        'tier_fired, confidence, rule_matched, llm_rationale, dry_run, applied_ok, workflow_version, error_text',
        ') values (' + values.join(', ') + ') returning id',
      ].join(' '),
    },
  };
});
`;

  const prepareLivePatchCode = String.raw`
const response = $('Merge DBHub Ollama Result').item.json;
const config = response.config || {};
const results = Array.isArray(response.results) ? response.results : [];
const auditRows = Array.isArray(response.audit_rows) ? response.audit_rows : [];
const isOutlookRun = String(response.mode || '').startsWith('outlook_metadata_');
const patchEnabled = config.enable_outlook_patch !== false && String(config.enable_outlook_patch).toLowerCase() !== 'false';
const mailbox = response.mailbox || config.ms_user_email;

if (config.dry_run) {
  return [{ json: { ...response, patch_needed: false, patch_requests: [], outlook_patch_status: 'skipped_dry_run' } }];
}
if (!patchEnabled) {
  return [{ json: { ...response, patch_needed: false, patch_requests: [], outlook_patch_status: 'disabled_until_enable_outlook_patch_true' } }];
}
if (!isOutlookRun) {
  return [{ json: { ...response, patch_needed: false, patch_requests: [], outlook_patch_status: 'skipped_not_outlook_run' } }];
}
if (!mailbox) {
  return [{ json: { ...response, patch_needed: false, patch_requests: [], outlook_patch_status: 'failed_missing_mailbox' } }];
}

const requests = results
  .map((result, index) => {
    const label = config.outlook_category_map?.[result.quadrant] || result.outlook_category_label || auditRows[index]?.outlook_category_label;
    if (!result.message_id || !label || result.error_text) return null;
    const categories = Array.from(new Set([...(Array.isArray(result.categories) ? result.categories : []), label]));
    return {
      id: String(index),
      method: 'PATCH',
      url: '/users/' + encodeURIComponent(mailbox) + '/messages/' + encodeURIComponent(result.message_id),
      headers: { 'Content-Type': 'application/json' },
      body: { categories },
    };
  })
  .filter(Boolean);

return [{
  json: {
    ...response,
    patch_needed: requests.length > 0,
    patch_requests: requests,
    outlook_patch_status: requests.length ? 'pending_outlook_patch' : 'skipped_no_patch_candidates',
    batch_body: { requests },
  },
}];
`;

  const skipLivePatchCode = String.raw`
const response = $('Prepare Live Outlook Patch Batch').item.json;
return [{ json: response }];
`;

  const mergeLivePatchCode = String.raw`
const response = $('Prepare Live Outlook Patch Batch').item.json;
const transportError = $json.error?.message || $json.message || $json.description || '';
const graphResponses = Array.isArray($json.responses)
  ? $json.responses
  : Array.isArray($json.body?.responses)
    ? $json.body.responses
    : Array.isArray($json.data?.responses)
      ? $json.data.responses
      : [];
const byId = new Map(graphResponses.map((item) => [String(item.id || ''), item]));
const requestedIds = new Set((response.patch_requests || []).map((request) => String(request.id)));
const assumeSubmitted = !transportError && requestedIds.size > 0 && graphResponses.length === 0;
let failures = transportError ? requestedIds.size : 0;

const results = (response.results || []).map((result, index) => {
  if (transportError) {
    return { ...result, applied_ok: false, error_text: transportError };
  }
  const patch = byId.get(String(index));
  if (!patch) {
    return {
      ...result,
      applied_ok: assumeSubmitted && requestedIds.has(String(index)),
      error_text: result.error_text || null,
    };
  }
  const ok = Number(patch.status) >= 200 && Number(patch.status) < 300;
  if (!ok) failures += 1;
  return {
    ...result,
    applied_ok: ok,
    error_text: ok ? result.error_text || null : (patch.body?.error?.message || 'Outlook PATCH failed with status ' + patch.status),
  };
});

const auditRows = (response.audit_rows || []).map((row, index) => {
  const result = results[index] || {};
  return {
    ...row,
    applied_ok: Boolean(result.applied_ok),
    error_text: result.error_text || row.error_text || null,
  };
});

return [{
  json: {
    ...response,
    results,
    audit_rows: auditRows,
    outlook_patch_status: failures ? 'failed_outlook_patch' : assumeSubmitted ? 'submitted_outlook_patch_no_response_body' : 'patched_outlook_categories',
    outlook_patch_count: assumeSubmitted ? requestedIds.size : graphResponses.length - failures,
    outlook_patch_error_count: failures,
  },
}];
`;

  const prepareAuditInsertCodeWithPatch = prepareAuditInsertCode.replace(
    "const response = $('Merge DBHub Ollama Result').item.json;",
    'const response = $json;',
  ).replace(
    'query: [',
    'response,\n      query: [',
  );

  const restoreAuditResponseCode = String.raw`
const inserted = $input.all();
const preparedItems = $('Prepare Audit Insert Rows').all();
const response = preparedItems[0]?.json?.response || {};
if (!Array.isArray(response.audit_rows) || !response.audit_rows.length) {
  return [{ json: { ...response, audit_status: 'skipped_no_audit_rows', audit_insert_count: 0, audit_error: '' } }];
}
const failed = inserted
  .map((item) => item.json?.error || item.json?.message || item.json?.description)
  .filter(Boolean);
const cleanedRows = (response.audit_rows || []).map((row) => ({
  ...row,
  original_categories: Array.isArray(row.original_categories) ? row.original_categories : [],
}));

return [{
  json: {
    ...response,
    audit_status: failed.length ? 'failed_postgres_insert' : 'inserted_postgres',
    audit_insert_count: failed.length ? 0 : inserted.length,
    audit_error: failed.length ? String(failed[0]).slice(0, 500) : '',
    audit_rows: cleanedRows,
  },
}];
`;

  return {
    name,
    nodes: [
      {
        parameters: {},
        id: 'manual-test-trigger',
        name: 'Manual Test Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
      {
        parameters: {
          httpMethod: 'POST',
          path: 'email-categorizer-test',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'email-categorizer-test-webhook',
        name: 'Email Categorizer Test Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        position: [0, 220],
      },
      {
        parameters: {
          rule: {
            interval: [{ field: 'minutes', minutesInterval: 30 }],
          },
        },
        id: 'email-categorizer-live-schedule',
        name: 'Email Categorizer Live Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, -120],
        disabled: !config.enable_schedule_processing,
      },
      {
        parameters: {
          mode: 'manual',
          includeOtherFields: true,
          assignments: {
            assignments: [{ id: 'config-object', name: 'config', type: 'object', value: config }],
          },
        },
        id: 'config',
        name: 'CONFIG',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [280, 120],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ String(Array.isArray($json.body?.messages) || $json.body?.use_outlook === false) }}',
                operator: { type: 'string', operation: 'equals' },
                rightValue: 'true',
              },
            ],
            combinator: 'and',
          },
        },
        id: 'use-provided-or-sample',
        name: 'Use Provided Or Sample?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.3,
        position: [560, 120],
      },
      {
        parameters: {
          method: 'GET',
          url: '={{ "https://graph.microsoft.com/v1.0/users/" + $json.config.ms_user_email + "/mailFolders/inbox/messages?$top=" + Number($json.config.batch_limit || 25) + "&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,importance,hasAttachments,categories,isRead&$filter=isRead eq false" }}',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftOutlookOAuth2Api',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
          options: {},
        },
        credentials: {
          microsoftOutlookOAuth2Api: {
            id: 'UPbI07LdV7IQhWzs',
            name: 'Microsoft Outlook account',
          },
        },
        id: 'get-unread-outlook-metadata',
        name: 'Get Unread Outlook Metadata',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [840, 260],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: normalizeOutlookCode,
        },
        id: 'normalize-outlook-metadata',
        name: 'Normalize Outlook Metadata',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1120, 260],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: classifyCode,
        },
        id: 'classify-with-dbhub-ollama',
        name: 'Prepare Dry Run Classification',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1400, 120],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ String(Number($json.needs_tier3_count || 0) > 0 && $json.config.enable_tier3_local_llm === true) }}',
                operator: { type: 'string', operation: 'equals' },
                rightValue: 'true',
              },
            ],
            combinator: 'and',
          },
        },
        id: 'needs-dbhub-ollama-tier3',
        name: 'Needs DBHub Ollama Tier 3?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.3,
        position: [1680, 120],
      },
      {
        parameters: {
          method: 'POST',
          url: '={{ $json.config.local_llm_base_url + "/api/chat" }}',
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json.ollama_request) }}',
          options: {},
        },
        id: 'call-dbhub-ollama',
        name: 'Call DBHub Ollama',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [1960, 40],
        continueOnFail: true,
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: mergeOllamaCode,
        },
        id: 'merge-dbhub-ollama-result',
        name: 'Merge DBHub Ollama Result',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2240, 120],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: prepareLivePatchCode,
        },
        id: 'prepare-live-outlook-patch-batch',
        name: 'Prepare Live Outlook Patch Batch',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2520, 120],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ String($json.patch_needed === true) }}',
                operator: { type: 'string', operation: 'equals' },
                rightValue: 'true',
              },
            ],
            combinator: 'and',
          },
        },
        id: 'live-outlook-patch-needed',
        name: 'Live Outlook Patch Needed?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.3,
        position: [2800, 120],
      },
      {
        parameters: {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/$batch',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftOutlookOAuth2Api',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json.batch_body) }}',
          options: {},
        },
        credentials: {
          microsoftOutlookOAuth2Api: {
            id: 'UPbI07LdV7IQhWzs',
            name: 'Microsoft Outlook account',
          },
        },
        id: 'patch-outlook-categories',
        name: 'Patch Outlook Categories',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [3080, 40],
        continueOnFail: true,
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: mergeLivePatchCode,
        },
        id: 'merge-live-outlook-patch-result',
        name: 'Merge Live Outlook Patch Result',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [3360, 40],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: skipLivePatchCode,
        },
        id: 'merge-skipped-outlook-patch-result',
        name: 'Merge Skipped Outlook Patch Result',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [3360, 220],
      },
      ...(enablePostgresAudit
        ? [
            {
              parameters: {
                mode: 'runOnceForAllItems',
                language: 'javaScript',
                jsCode: prepareAuditInsertCodeWithPatch,
              },
              id: 'prepare-audit-insert',
              name: 'Prepare Audit Insert Rows',
              type: 'n8n-nodes-base.code',
              typeVersion: 2,
              position: [3640, 120],
            },
            {
              parameters: {
                resource: 'database',
                operation: 'executeQuery',
                query: '={{ $json.query }}',
                options: {
                  queryBatching: 'independently',
                },
              },
              credentials: {
                postgres: {
                  id: 'ksnKn12JiFB34IUU',
                  name: 'Email Categorizer Postgres',
                },
              },
              id: 'insert-audit-rows',
              name: 'Insert Audit Rows',
              type: 'n8n-nodes-base.postgres',
              typeVersion: 2.6,
              position: [3920, 120],
              continueOnFail: true,
            },
            {
              parameters: {
                mode: 'runOnceForAllItems',
                language: 'javaScript',
                jsCode: restoreAuditResponseCode,
              },
              id: 'restore-audit-response',
              name: 'Restore Audit Response',
              type: 'n8n-nodes-base.code',
              typeVersion: 2,
              position: [4200, 120],
            },
          ]
        : []),
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: { responseCode: 200 },
        },
        id: 'return-dry-run-result',
        name: 'Return Email Categorizer Result',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.4,
        position: [4480, 120],
      },
    ],
    connections: {
      'Manual Test Trigger': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      'Email Categorizer Test Webhook': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      'Email Categorizer Live Schedule': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      CONFIG: { main: [[{ node: 'Use Provided Or Sample?', type: 'main', index: 0 }]] },
      'Use Provided Or Sample?': {
        main: [
          [{ node: 'Prepare Dry Run Classification', type: 'main', index: 0 }],
          [{ node: 'Get Unread Outlook Metadata', type: 'main', index: 0 }],
        ],
      },
      'Get Unread Outlook Metadata': { main: [[{ node: 'Normalize Outlook Metadata', type: 'main', index: 0 }]] },
      'Normalize Outlook Metadata': { main: [[{ node: 'Prepare Dry Run Classification', type: 'main', index: 0 }]] },
      'Prepare Dry Run Classification': { main: [[{ node: 'Needs DBHub Ollama Tier 3?', type: 'main', index: 0 }]] },
      'Needs DBHub Ollama Tier 3?': {
        main: [
          [{ node: 'Call DBHub Ollama', type: 'main', index: 0 }],
          [{ node: 'Merge DBHub Ollama Result', type: 'main', index: 0 }],
        ],
      },
      'Call DBHub Ollama': { main: [[{ node: 'Merge DBHub Ollama Result', type: 'main', index: 0 }]] },
      'Merge DBHub Ollama Result': { main: [[{ node: 'Prepare Live Outlook Patch Batch', type: 'main', index: 0 }]] },
      'Prepare Live Outlook Patch Batch': { main: [[{ node: 'Live Outlook Patch Needed?', type: 'main', index: 0 }]] },
      'Live Outlook Patch Needed?': {
        main: [
          [{ node: 'Patch Outlook Categories', type: 'main', index: 0 }],
          [{ node: 'Merge Skipped Outlook Patch Result', type: 'main', index: 0 }],
        ],
      },
      'Patch Outlook Categories': { main: [[{ node: 'Merge Live Outlook Patch Result', type: 'main', index: 0 }]] },
      ...(enablePostgresAudit
        ? {
            'Merge Live Outlook Patch Result': { main: [[{ node: 'Prepare Audit Insert Rows', type: 'main', index: 0 }]] },
            'Merge Skipped Outlook Patch Result': { main: [[{ node: 'Prepare Audit Insert Rows', type: 'main', index: 0 }]] },
            'Prepare Audit Insert Rows': { main: [[{ node: 'Insert Audit Rows', type: 'main', index: 0 }]] },
            'Insert Audit Rows': { main: [[{ node: 'Restore Audit Response', type: 'main', index: 0 }]] },
            'Restore Audit Response': { main: [[{ node: 'Return Email Categorizer Result', type: 'main', index: 0 }]] },
          }
        : {
            'Merge Live Outlook Patch Result': { main: [[{ node: 'Return Email Categorizer Result', type: 'main', index: 0 }]] },
            'Merge Skipped Outlook Patch Result': { main: [[{ node: 'Return Email Categorizer Result', type: 'main', index: 0 }]] },
          }),
    },
    settings: { executionOrder: 'v1', availableInMCP: true },
  };
}

function buildEmailCorrectionReviewRestWorkflow(name) {
  const config = {
    ms_user_email: 'dbradley@tciallc.com',
    audit_table: 'inbox_classifications',
    correction_table: 'inbox_classification_corrections',
    lookback_days: 7,
    batch_limit: 20,
    workflow_version: name,
    outlook_category_labels: ['Q1: Do Now', 'Q2: Schedule', 'Q3: Delegate', 'Q4: Eliminate', 'QR: Quarantine'],
  };

  const buildBatchCode = String.raw`
const config = $('CONFIG').item.json.config || {};
const rows = $input.all().map((item) => item.json).filter((row) => row.message_id);
if (!rows.length) {
  return [{
    json: {
      config,
      audit_rows: [],
      requests: [{ id: '0', method: 'GET', url: '/users/' + encodeURIComponent(config.ms_user_email) + '?$select=id' }],
      correction_status: 'skipped_no_recent_audit_rows',
    },
  }];
}

function odataString(value) {
  return String(value || '').replace(/'/g, "''");
}

return [{
  json: {
    config,
    audit_rows: rows,
    requests: rows
      .map((row, index) => row.internet_message_id ? ({
        id: String(index),
        method: 'GET',
        url:
          '/users/' +
          encodeURIComponent(config.ms_user_email) +
          '/messages?$filter=' +
          encodeURIComponent("internetMessageId eq '" + odataString(row.internet_message_id) + "'") +
          '&$select=id,internetMessageId,categories',
      }) : null)
      .filter(Boolean),
  },
}];
`;

  const prepareCorrectionInsertsCode = String.raw`
const source = $('Build Outlook Category Batch').item.json;
const config = source.config || {};
const auditRows = Array.isArray(source.audit_rows) ? source.audit_rows : [];
const responses = Array.isArray($json.responses) ? $json.responses : [];
const categoryLabels = new Set(config.outlook_category_labels || []);

function sql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

const corrections = [];
for (const response of responses) {
  const index = Number(response.id);
  const audit = auditRows[index];
  if (!audit || response.status < 200 || response.status >= 300) continue;
  const message = Array.isArray(response.body?.value) ? response.body.value[0] : response.body;
  const categories = Array.isArray(message?.categories) ? message.categories : [];
  const observed = categories.find((label) => categoryLabels.has(label));
  if (!observed || observed === audit.outlook_category_label) continue;
  corrections.push({
    classification_id: audit.id,
    message_id: audit.message_id,
    predicted_quadrant: audit.quadrant,
    predicted_category_label: audit.outlook_category_label,
    observed_category_label: observed,
  });
}

if (!corrections.length) {
  return [{ json: { query: "select null::int as id, 'no_manual_corrections_detected' as correction_status", checked_rows: auditRows.length } }];
}

return corrections.map((row) => ({
  json: {
    query: [
      'insert into inbox_classification_corrections (',
      'classification_id, message_id, predicted_quadrant, predicted_category_label, observed_category_label, correction_source',
      ') values (',
      [sql(row.classification_id), sql(row.message_id), sql(row.predicted_quadrant), sql(row.predicted_category_label), sql(row.observed_category_label), sql('outlook_manual_change')].join(', '),
      ') on conflict (message_id, observed_category_label) do nothing returning id',
    ].join(' '),
  },
}));
`;

  const restoreCorrectionResponseCode = String.raw`
const inserted = $input.all();
const insertedCount = inserted.filter((item) => item.json?.id).length;
const noopStatus = inserted.find((item) => item.json?.correction_status)?.json?.correction_status;
return [{
  json: {
    ok: true,
    action: 'email_categorizer_correction_review',
    correction_status: noopStatus || 'inserted_corrections',
    correction_insert_count: insertedCount,
    workflow_version: $('CONFIG').item.json.config?.workflow_version,
  },
}];
`;

  return {
    name,
    nodes: [
      {
        parameters: {},
        id: 'manual-trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
      {
        parameters: {
          rule: {
            interval: [{ field: 'cronExpression', expression: '0 23 * * *' }],
          },
        },
        id: 'nightly-schedule',
        name: 'Nightly Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 220],
      },
      {
        parameters: {
          mode: 'manual',
          includeOtherFields: true,
          assignments: {
            assignments: [{ id: 'config-object', name: 'config', type: 'object', value: config }],
          },
        },
        id: 'config',
        name: 'CONFIG',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [280, 120],
      },
      {
        parameters: {
          resource: 'database',
          operation: 'executeQuery',
          query:
            "select distinct on (message_id) id, message_id, internet_message_id, quadrant, outlook_category_label, classified_at from inbox_classifications where classified_at >= now() - interval '7 days' order by message_id, classified_at desc limit 20",
          options: { queryBatching: 'independently' },
        },
        credentials: {
          postgres: {
            id: 'ksnKn12JiFB34IUU',
            name: 'Email Categorizer Postgres',
          },
        },
        id: 'load-recent-audit-rows',
        name: 'Load Recent Audit Rows',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [560, 120],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: buildBatchCode,
        },
        id: 'build-outlook-category-batch',
        name: 'Build Outlook Category Batch',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [840, 120],
      },
      {
        parameters: {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/$batch',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftOutlookOAuth2Api',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }, { name: 'Content-Type', value: 'application/json' }] },
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ requests: $json.requests || [] }) }}',
          options: {},
        },
        credentials: {
          microsoftOutlookOAuth2Api: {
            id: 'UPbI07LdV7IQhWzs',
            name: 'Microsoft Outlook account',
          },
        },
        id: 'fetch-current-outlook-categories',
        name: 'Fetch Current Outlook Categories',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [1120, 120],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: prepareCorrectionInsertsCode,
        },
        id: 'prepare-correction-inserts',
        name: 'Prepare Correction Inserts',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1400, 120],
      },
      {
        parameters: {
          resource: 'database',
          operation: 'executeQuery',
          query: '={{ $json.query }}',
          options: { queryBatching: 'independently' },
        },
        credentials: {
          postgres: {
            id: 'ksnKn12JiFB34IUU',
            name: 'Email Categorizer Postgres',
          },
        },
        id: 'insert-correction-rows',
        name: 'Insert Correction Rows',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [1680, 120],
        continueOnFail: true,
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: restoreCorrectionResponseCode,
        },
        id: 'restore-correction-response',
        name: 'Restore Correction Response',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1960, 120],
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      'Nightly Schedule': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      CONFIG: { main: [[{ node: 'Load Recent Audit Rows', type: 'main', index: 0 }]] },
      'Load Recent Audit Rows': { main: [[{ node: 'Build Outlook Category Batch', type: 'main', index: 0 }]] },
      'Build Outlook Category Batch': { main: [[{ node: 'Fetch Current Outlook Categories', type: 'main', index: 0 }]] },
      'Fetch Current Outlook Categories': { main: [[{ node: 'Prepare Correction Inserts', type: 'main', index: 0 }]] },
      'Prepare Correction Inserts': { main: [[{ node: 'Insert Correction Rows', type: 'main', index: 0 }]] },
      'Insert Correction Rows': { main: [[{ node: 'Restore Correction Response', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', availableInMCP: true },
  };
}

function buildEmailRuleSuggestionRestWorkflow(name) {
  const config = {
    github_owner: 'choicedrum-crypto',
    github_repo: 'agentic-buildout-starter',
    correction_table: 'inbox_classification_corrections',
    audit_table: 'inbox_classifications',
    workflow_version: name,
    max_corrections: 25,
    issue_labels: ['automation', 'codex-ready'],
  };

  const buildIssueCode = String.raw`
const config = $('CONFIG').item.json.config || {};
const rows = $input.all().map((item) => item.json).filter((row) => row.correction_id);

function words(subject) {
  return String(subject || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !['automatic', 'reply', 'client', 'file', 'request'].includes(word))
    .slice(0, 6);
}

if (!rows.length) {
  return [{ json: { config, has_suggestions: false, correction_ids: [], status: 'no_new_corrections' } }];
}

const groups = new Map();
for (const row of rows) {
  const key = [
    row.sender_domain || 'unknown-domain',
    row.predicted_category_label || row.predicted_quadrant || 'unknown-prediction',
    row.observed_category_label || 'unknown-observed',
  ].join('|');
  const current = groups.get(key) || {
    sender_domain: row.sender_domain || '',
    predicted_category_label: row.predicted_category_label || '',
    observed_category_label: row.observed_category_label || '',
    count: 0,
    subjects: [],
    keywords: new Map(),
  };
  current.count += 1;
  if (row.subject) current.subjects.push(String(row.subject).slice(0, 160));
  for (const word of words(row.subject)) {
    current.keywords.set(word, (current.keywords.get(word) || 0) + 1);
  }
  groups.set(key, current);
}

const suggestions = [...groups.values()]
  .sort((a, b) => b.count - a.count)
  .map((group) => {
    const keywords = [...group.keywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);
    return { ...group, keywords };
  });

const correctionIds = rows.map((row) => Number(row.correction_id)).filter(Number.isFinite);
const lines = [
  '## Goal',
  'Update the Email Categorizer classifier rules using manual Outlook category corrections captured by the n8n feedback loop.',
  '',
  '## Suggested Rule Changes',
  ...suggestions.flatMap((item, index) => [
    '',
    '### Suggestion ' + (index + 1),
    '- Sender domain: ' + (item.sender_domain || 'mixed/unknown'),
    '- Current prediction: ' + (item.predicted_category_label || 'unknown'),
    '- Manual category: ' + (item.observed_category_label || 'unknown'),
    '- Corrections observed: ' + item.count,
    '- Subject keywords: ' + (item.keywords.length ? item.keywords.join(', ') : 'none'),
    '- Example subjects:',
    ...item.subjects.slice(0, 5).map((subject) => '  - ' + subject),
  ]),
  '',
  '## Acceptance Criteria',
  '- Implement a conservative classifier rule update in scripts/build-n8n-workflows.mjs only.',
  '- Keep the workflow dry-run first; do not enable Outlook PATCH/category writes.',
  '- Keep DBHub Ollama as Tier 3 fallback for ambiguous messages.',
  '- Add or update focused validation for the rule behavior if practical.',
  '- Open a PR against main through the standard Codex PR flow.',
  '',
  '## Safety',
  '- Do not include secrets.',
  '- Do not read email bodies or attachments.',
  '- Do not deploy directly from Codex.',
  '',
  '## Automation Metadata',
  'source_workflow: Email Categorizer Rule Suggestion',
  'correction_ids: ' + correctionIds.join(','),
  'workflow_version: ' + config.workflow_version,
];

return [{
  json: {
    config,
    has_suggestions: true,
    correction_ids: correctionIds,
    issue_title: 'Email Categorizer suggested rule update - ' + new Date().toISOString().slice(0, 10),
    issue_body: lines.join('\n'),
  },
}];
`;

  const prepareUpdateCode = String.raw`
const source = $('Build Rule Suggestion Issue').item.json;
const issue = $('Create Rule Suggestion Issue').item.json;
const ids = (source.correction_ids || []).map(Number).filter(Number.isFinite);
if (!ids.length) {
  return [{ json: { query: "select 0::int as updated_rows" } }];
}
const issueUrl = issue.html_url || '';
const issueNumber = issue.number || '';
const notes = "Suggested rule issue #" + issueNumber + ": " + issueUrl;
return [{
  json: {
    query:
      "update inbox_classification_corrections set rule_suggestion_status = 'proposed', notes = " +
      "'" + notes.replace(/'/g, "''") + "' where id in (" + ids.join(',') + ") and rule_suggestion_status = 'new' returning id",
    issue_url: issueUrl,
    issue_number: issueNumber,
  },
}];
`;

  return {
    name,
    nodes: [
      {
        parameters: {},
        id: 'manual-trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
      {
        parameters: {
          rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1' }] },
        },
        id: 'weekly-schedule',
        name: 'Weekly Schedule',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 220],
      },
      {
        parameters: {
          mode: 'manual',
          includeOtherFields: true,
          assignments: {
            assignments: [{ id: 'config-object', name: 'config', type: 'object', value: config }],
          },
        },
        id: 'config',
        name: 'CONFIG',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [280, 120],
      },
      {
        parameters: {
          resource: 'database',
          operation: 'executeQuery',
          query:
            "select c.id as correction_id, c.classification_id, c.message_id, c.predicted_quadrant, c.predicted_category_label, c.observed_category_label, c.detected_at, i.subject, i.sender, i.sender_domain, i.importance, i.has_attachments from inbox_classification_corrections c left join inbox_classifications i on i.id = c.classification_id where c.rule_suggestion_status = 'new' order by c.detected_at asc limit 25",
          options: { queryBatching: 'independently' },
        },
        credentials: {
          postgres: {
            id: 'ksnKn12JiFB34IUU',
            name: 'Email Categorizer Postgres',
          },
        },
        id: 'load-new-corrections',
        name: 'Load New Corrections',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [560, 120],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: buildIssueCode,
        },
        id: 'build-rule-suggestion-issue',
        name: 'Build Rule Suggestion Issue',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [840, 120],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ String($json.has_suggestions) }}',
                operator: { type: 'string', operation: 'equals' },
                rightValue: 'true',
              },
            ],
            combinator: 'and',
          },
        },
        id: 'has-rule-suggestions',
        name: 'Has Rule Suggestions?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.3,
        position: [1120, 120],
      },
      {
        parameters: {
          method: 'POST',
          url: '={{ "https://api.github.com/repos/" + $json.config.github_owner + "/" + $json.config.github_repo + "/issues" }}',
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }, { name: 'Content-Type', value: 'application/json' }] },
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ title: $json.issue_title, body: $json.issue_body, labels: $json.config.issue_labels }) }}',
          options: {},
        },
        credentials: { httpHeaderAuth: { id: 'PINH6cogiqn4H9b9', name: 'GitHub HTTP Bearer' } },
        id: 'create-rule-suggestion-issue',
        name: 'Create Rule Suggestion Issue',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [1400, 80],
      },
      {
        parameters: {
          method: 'POST',
          url: '={{ "https://api.github.com/repos/" + $("Build Rule Suggestion Issue").item.json.config.github_owner + "/" + $("Build Rule Suggestion Issue").item.json.config.github_repo + "/issues/" + $json.number + "/comments" }}',
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }, { name: 'Content-Type', value: 'application/json' }] },
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody:
            '={{ JSON.stringify({ body: "@codex please implement this email categorizer rule suggestion. Use the issue body as the source of truth. Create a feature branch, update the classifier conservatively, run validation, and open a PR against main. Do not deploy directly from Codex." }) }}',
          options: {},
        },
        credentials: { httpHeaderAuth: { id: 'PINH6cogiqn4H9b9', name: 'GitHub HTTP Bearer' } },
        id: 'request-codex-rule-pr',
        name: 'Request Codex Rule PR',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.4,
        position: [1680, 80],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: prepareUpdateCode,
        },
        id: 'prepare-correction-status-update',
        name: 'Prepare Correction Status Update',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1960, 80],
      },
      {
        parameters: {
          resource: 'database',
          operation: 'executeQuery',
          query: '={{ $json.query }}',
          options: { queryBatching: 'independently' },
        },
        credentials: {
          postgres: {
            id: 'ksnKn12JiFB34IUU',
            name: 'Email Categorizer Postgres',
          },
        },
        id: 'mark-corrections-proposed',
        name: 'Mark Corrections Proposed',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [2240, 80],
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      'Weekly Schedule': { main: [[{ node: 'CONFIG', type: 'main', index: 0 }]] },
      CONFIG: { main: [[{ node: 'Load New Corrections', type: 'main', index: 0 }]] },
      'Load New Corrections': { main: [[{ node: 'Build Rule Suggestion Issue', type: 'main', index: 0 }]] },
      'Build Rule Suggestion Issue': { main: [[{ node: 'Has Rule Suggestions?', type: 'main', index: 0 }]] },
      'Has Rule Suggestions?': { main: [[{ node: 'Create Rule Suggestion Issue', type: 'main', index: 0 }], []] },
      'Create Rule Suggestion Issue': { main: [[{ node: 'Request Codex Rule PR', type: 'main', index: 0 }]] },
      'Request Codex Rule PR': { main: [[{ node: 'Prepare Correction Status Update', type: 'main', index: 0 }]] },
      'Prepare Correction Status Update': { main: [[{ node: 'Mark Corrections Proposed', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', availableInMCP: true },
  };
}

async function createEmailWorkflowViaRest(name) {
  const existing = await n8nApi('GET', `/workflows?name=${encodeURIComponent('Email Categorizer')}&limit=100`);
  const previous = (existing.data || []).filter(
    (workflowItem) =>
      workflowItem.id &&
      (workflowItem.name === 'Email Categorizer' || workflowItem.name.startsWith('Email Categorizer - Published ')),
  );
  for (const workflowItem of previous) {
    if (workflowItem.active) {
      await n8nApi('POST', `/workflows/${workflowItem.id}/deactivate`);
      console.log(`deactivated previous Email Categorizer (${workflowItem.id})`);
    }
  }

  const created = await n8nApi('POST', '/workflows', buildEmailCategorizerRestWorkflow(name));
  await n8nApi('POST', `/workflows/${created.id}/activate`, {});
  return created.id;
}

async function createRestWorkflowViaRest(baseName, publishedName, builder) {
  const existing = await n8nApi('GET', `/workflows?name=${encodeURIComponent(baseName)}&limit=100`);
  const previous = (existing.data || []).filter(
    (workflowItem) => workflowItem.id && (workflowItem.name === baseName || workflowItem.name.startsWith(`${baseName} - Published `)),
  );
  for (const workflowItem of previous) {
    if (workflowItem.active) {
      await n8nApi('POST', `/workflows/${workflowItem.id}/deactivate`);
      console.log(`deactivated previous ${baseName} (${workflowItem.id})`);
    }
  }

  const created = await n8nApi('POST', '/workflows', builder(publishedName));
  await n8nApi('POST', `/workflows/${created.id}/activate`, {});
  return created.id;
}

const planeApiCredential = 'Plane Main';
const githubCredential = 'GitHub account';
const githubHttpCredential = 'GitHub HTTP Bearer';
const slackHttpCredential = 'Slack Bot HTTP Bearer';

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
const planeProjectId = issue.project_id || issue.project?.id || issue.project?.uuid || body.project_id || body.project?.id || config.plane_project_id || '';
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
  '- Plane Project ID: ' + (planeProjectId || 'Not provided'),
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
  'plane_project_id: ' + planeProjectId,
  'plane_url: ' + planeUrl,
  'plane_workspace_slug: ' + (config.plane_workspace_slug || ''),
  'github_issue_number: pending',
  'source_workflow: Plane Ready to GitHub Issue',
].join('\\\\n');
return { json: { ...$json, config, plane_issue_id: planeIssueId, plane_project_id: planeProjectId, plane_issue_key: planeIssueKey, plane_title: title, plane_description: description, plane_state: stateValue, plane_state_id: stateId, plane_url: planeUrl, existing_github_issue_url: existing, ready, has_existing_github_issue: Boolean(existing), github_issue_title: '[Plane] ' + title, github_issue_body: issueBody } };
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
      title: expr('{{ $("Normalize Plane Payload").item.json.github_issue_title }}'),
      body: expr('{{ $("Normalize Plane Payload").item.json.github_issue_body }}'),
      labels: [{ label: 'plane' }, { label: 'codex-ready' }, { label: 'automation' }]
    }
  }
});

const claimIssue = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Claim Plane for Codex',
    alwaysOutputData: true,
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: expr('{{ $("Normalize Plane Payload").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Normalize Plane Payload").item.json.config.plane_workspace_slug + "/projects/" + $("Normalize Plane Payload").item.json.plane_project_id + "/work-items/" + $("Normalize Plane Payload").item.json.plane_issue_id + "/comments/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { comment_html: "<p>Claimed by Codex routing workflow for GitHub issue creation.</p><ul><li>Workflow: Plane Ready to GitHub Issue</li><li>Labels: " + (($("Normalize Plane Payload").item.json.plane_labels || []).join(", ") || "none") + "</li><li>Claimed at: " + new Date().toISOString() + "</li></ul>", comment_json: {}, access: "INTERNAL", external_source: "codex-routing", external_id: String("codex-claim-" + $("Normalize Plane Payload").item.json.plane_issue_id + "-" + Date.now()) } }}')
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
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'POST',
      url: expr('{{ $("Normalize Plane Payload").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Normalize Plane Payload").item.json.config.plane_workspace_slug + "/projects/" + $("Normalize Plane Payload").item.json.plane_project_id + "/work-items/" + $("Normalize Plane Payload").item.json.plane_issue_id + "/comments/" }}'),
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
      .onTrue(claimIssue.to(createIssue).to(waitForGitHubIndex).to(searchCanonicalGitHubIssue).to(resolveCanonicalGitHubIssue).to(upsertIssueLock).to(duplicateCreated
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
const prBody = pr.body || '';
const metadataText = [prBody, pr.title || ''].join('\\\\n');
const issueNumber =
  prBody.match(/github_issue_number:\\\\s*(\\\\d+)/i)?.[1] ||
  prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\\\s+#(\\\\d+)/i)?.[1] ||
  '';
const issueUrl = issueNumber
  ? 'https://github.com/' + config.github_owner + '/' + config.github_repo + '/issues/' + issueNumber
  : '';
const planeUrl = metadataText.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const planeIssueId = metadataText.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeProjectId = metadataText.match(/plane_project_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || config.plane_project_id || '';
const reviewable = ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
const message = [
  'Approval needed',
  'Plane: ' + (planeUrl || planeIssueId || 'Not linked'),
  'GitHub Issue: ' + (issueUrl || 'Not linked'),
  'PR: ' + (pr.html_url || 'Not provided'),
  'Checks: pending or see GitHub PR',
  'Summary: ' + (pr.title || 'PR opened'),
  'Decision: Approve, Request Changes, or Block from Slack.'
].join('\\\\n');
const slackBlocks = [
  { type: 'section', text: { type: 'mrkdwn', text: '*' + (pr.title || 'PR opened') + '*\\\\n' + message } },
  {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve', value: JSON.stringify({ decision: 'approve', pr_number: pr.number || '', plane_issue_id: planeIssueId, plane_project_id: planeProjectId }) },
      { type: 'button', text: { type: 'plain_text', text: 'Request Changes' }, action_id: 'request_changes', value: JSON.stringify({ decision: 'request_changes', pr_number: pr.number || '', plane_issue_id: planeIssueId, plane_project_id: planeProjectId }) },
      { type: 'button', text: { type: 'plain_text', text: 'Block' }, style: 'danger', action_id: 'block', value: JSON.stringify({ decision: 'block', pr_number: pr.number || '', plane_issue_id: planeIssueId, plane_project_id: planeProjectId }) },
    ],
  },
];
return { json: { ...$json, config, action, reviewable, pr_number: pr.number || '', pr_title: pr.title, pr_url: pr.html_url, pr_merge_link: pr.html_url, issue_url: issueUrl, plane_url: planeUrl, plane_issue_id: planeIssueId, plane_project_id: planeProjectId, plane_state_id: config.plane_review_state_id, slack_message: message, slack_blocks: slackBlocks, slack_blocks_json: JSON.stringify(slackBlocks) } };
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
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
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

const listPlaneReviewStates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Plane Review States',
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'GET',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.plane_project_id + "/states/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] }
    }
  }
});

const resolvePlaneReviewState = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Plane Review State',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Extract PR Review Context').item.json;
const states = Array.isArray($json.results) ? $json.results : (Array.isArray($json) ? $json : []);
const review = states.find((state) => String(state.name || '').toLowerCase() === String(original.config.plane_review_state_name || 'Review').toLowerCase());
return {
  json: {
    ...original,
    plane_state_id: review?.id || original.config.plane_review_state_id,
    plane_state_name: review?.name || original.config.plane_review_state_name || 'Review',
  },
};
\`
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
      url: expr('{{ $("Extract PR Review Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Extract PR Review Context").item.json.config.plane_workspace_slug + "/projects/" + $("Extract PR Review Context").item.json.plane_project_id + "/work-items/" + $("Extract PR Review Context").item.json.plane_issue_id + "/comments/" }}'),
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
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Slack Approval Message',
    credentials: { slackApi: newCredential('Slack account', 'slackApi') },
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { channel: $("Extract PR Review Context").item.json.config.slack_review_channel, text: $("Extract PR Review Context").item.json.slack_message, blocks: $("Extract PR Review Context").item.json.slack_blocks } }}')
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
      .onTrue(listPlaneReviewStates.to(resolvePlaneReviewState).to(updatePlaneReview).to(commentPlaneReview).to(restoreReviewMessage).to(slackReview).to(respondNotified))
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
  const githubActionsFailure = /github\.com$/.test(sender) && /\b(run failed|workflow failed|check suite failed|deploy after merge)\b/i.test(subject);
  const suspicious = /(wire|crypto|password|gift card|prize|urgent payment|bank|invoice)/i.test(subject) && (hasAttachments || /suspicious|unknown|external/.test(sender));
  const urgent = /(urgent|asap|today|escalation|blocked|down|outage|deadline)/i.test(subject) || importance === 'high';
  const planning = /(plan|planning|schedule|agenda|strategy|roadmap|next week|follow up)/i.test(subject);
  const delegate = /(delegate|assign|handoff|review requested|please review)/i.test(subject);
  const lowValue = /(newsletter|unsubscribe|promo|sale|digest|webinar)/i.test(subject);

  if (githubActionsFailure) return { quadrant: 'Q4', tier_fired: 1, confidence: 0.86, reason: 'GitHub Actions failure notification is low-value automation noise for this mailbox.' };
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
const planeProjectId = text.match(/plane_project_id:\\\\s*([A-Za-z0-9_-]+)/)?.[1] || config.plane_project_id || '';
const planeUrl = text.match(/https?:\\\\/\\\\/[^\\\\s)"]*plane[^\\\\s)"]*/i)?.[0] || '';
const prNumber = run.pull_requests?.[0]?.number || run.display_title?.match(/\\\\(#(\\\\d+)\\\\)/)?.[1] || run.head_commit?.message?.match(/\\\\(#(\\\\d+)\\\\)/)?.[1] || '';
const stateName = started ? config.plane_deploying_state_name : (success ? config.plane_done_state_name : config.plane_failed_state_name);
const message = [
  'Deployment ' + (started ? 'started' : (success ? 'succeeded' : 'failed')),
  'Repo: ' + (body.repository?.full_name || config.github_owner + '/' + config.github_repo),
  'Commit: ' + (run.head_sha || 'unknown'),
  'Run: ' + (run.html_url || 'not provided'),
  'Plane: ' + (planeUrl || planeIssueId || 'not resolved'),
  'Plane status update: ' + (planeIssueId ? (started ? 'Deploying queued' : 'queued') : 'skipped, Plane task not resolved')
].join('\\\\n');
return { json: { ...$json, config, is_deploy_workflow: isDeployWorkflow, completed, started, success, deployment_status: started ? 'started' : (success ? 'succeeded' : 'failed'), run_url: run.html_url, head_sha: run.head_sha, repository: body.repository?.full_name, pr_number: String(prNumber || ''), plane_issue_id: planeIssueId, plane_project_id: planeProjectId, plane_url: planeUrl, plane_state_name: stateName, slack_message: message } };
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
const planeProjectId =
  base.plane_project_id ||
  text.match(/plane_project_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] ||
  text.match(/Plane Project ID:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] ||
  base.config.plane_project_id ||
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
return { json: { ...base, plane_issue_id: planeIssueId, plane_project_id: planeProjectId, plane_url: planeUrl, pr_url: prUrl, github_issue_number: String(githubIssueNumber || ''), github_issue_url: githubIssueNumber ? 'https://github.com/' + base.config.github_owner + '/' + base.config.github_repo + '/issues/' + githubIssueNumber : '', slack_message: message } };
\`
    }
  }
});

const listPlaneDeploymentStates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Plane Deployment States',
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'GET',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.plane_project_id + "/states/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] }
    }
  }
});

const resolvePlaneDeploymentState = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Plane Deployment State',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Resolve Plane Context').item.json;
const states = Array.isArray($json.results) ? $json.results : (Array.isArray($json) ? $json : []);
const wantedName = original.plane_state_name || (original.success ? original.config.plane_done_state_name : original.config.plane_failed_state_name);
const state = states.find((item) => String(item.name || '').toLowerCase() === String(wantedName || '').toLowerCase());
const fallbackStateId = original.started ? original.config.plane_deploying_state_id : (original.success ? original.config.plane_done_state_id : original.config.plane_failed_state_id);
return {
  json: {
    ...original,
    plane_state_id: state?.id || fallbackStateId,
    plane_state_name: state?.name || wantedName,
  },
};
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
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
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
      url: expr('{{ $("Resolve Plane Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Resolve Plane Context").item.json.config.plane_workspace_slug + "/projects/" + $("Resolve Plane Context").item.json.plane_project_id + "/work-items/" + $("Resolve Plane Context").item.json.plane_issue_id + "/comments/" }}'),
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
        .onTrue(listPlaneDeploymentStates.to(resolvePlaneDeploymentState).to(updatePlane).to(commentPlaneDeployment).to(shouldCloseGitHubIssue
          .onTrue(commentGitHubIssueCompleted.to(closeGitHubIssueCompleted).to(restoreDeployMessage).to(slackDeploy).to(respondSynced))
          .onFalse(restoreDeployMessage.to(slackDeploy).to(respondSynced))))
        .onFalse(slackDeploy.to(respondSynced))))
      .onFalse(fetchPrsForCommit.to(resolvePlaneContext).to(hasPlane
        .onTrue(listPlaneDeploymentStates.to(resolvePlaneDeploymentState).to(updatePlane).to(commentPlaneDeployment).to(shouldCloseGitHubIssue
          .onTrue(commentGitHubIssueCompleted.to(closeGitHubIssueCompleted).to(restoreDeployMessage).to(slackDeploy).to(respondSynced))
          .onFalse(restoreDeployMessage.to(slackDeploy).to(respondSynced))))
        .onFalse(slackDeploy.to(respondSynced)))))
    .onFalse(respondIgnored));
`;

const codexDispatchWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const githubIssueWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'GitHub Issue Dispatch Webhook', parameters: { httpMethod: 'POST', path: 'github-issue-codex-dispatch', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true } } }
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
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_building_state_name: "Building", plane_building_state_id: "57e8338f-7181-44f6-9f5e-806a425ec6b2", codex_mention: "@codex", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }
        ]
      }
    }
  }
});

const extract = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Dispatch Context',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
const action = body.action || '';
const issue = body.issue || {};
const labels = (issue.labels || []).map((label) => String(label.name || label).toLowerCase());
const text = issue.body || '';
const planeIssueId = text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeProjectId = text.match(/plane_project_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeUrl = text.match(/plane_url:\\\\s*(\\\\S+)/i)?.[1] || '';
const issueNumber = issue.number || body.issue_number || '';
const eligibleAction = ['opened', 'edited', 'labeled', 'reopened'].includes(action);
const hasQueueLabels = ['plane', 'codex-ready', 'automation'].every((label) => labels.includes(label));
const alreadyClaimed = ['codex-in-progress', 'codex-pr-open', 'done', 'blocked'].some((label) => labels.includes(label));
const isPullRequest = Boolean(issue.pull_request);
const eligible = eligibleAction && hasQueueLabels && !alreadyClaimed && !isPullRequest && Boolean(issueNumber && planeIssueId && planeProjectId);
return {
  json: {
    ...$json,
    config,
    action,
    eligible,
    issue_number: String(issueNumber || ''),
    issue_url: issue.html_url || '',
    issue_title: issue.title || '',
    plane_issue_id: planeIssueId,
    plane_project_id: planeProjectId,
    plane_url: planeUrl,
    codex_comment: [
      (config.codex_mention || '@codex') + ' please implement this issue.',
      '',
      'Use the issue body as the source of truth. Create a feature branch, make the code changes, run appropriate validation, and open a PR against main.',
      '',
      'Include this metadata in the PR body:',
      'plane_issue_id: ' + planeIssueId,
      'plane_project_id: ' + planeProjectId,
      'github_issue_number: ' + issueNumber,
      'plane_url: ' + planeUrl,
      '',
      'Do not deploy from Codex.'
    ].join('\\\\n')
  }
};
\`
    }
  }
});

const shouldDispatch = ifElse({
  version: 2.3,
  config: {
    name: 'Eligible Issue?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.eligible) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const claimIssue = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Claim GitHub Issue',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'edit',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($json.issue_number) }}'),
      editFields: { labels: [{ label: 'plane' }, { label: 'codex-ready' }, { label: 'automation' }, { label: 'codex-in-progress' }] }
    }
  }
});

const requestCodex = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Request Codex Build',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'createComment',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($("Extract Dispatch Context").item.json.issue_number) }}'),
      body: expr('{{ $("Extract Dispatch Context").item.json.codex_comment }}')
    }
  }
});

const listPlaneBuildingStates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'List Plane Building States',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'GET',
      url: expr('{{ $("Extract Dispatch Context").item.json.config.plane_api_base_url + "/api/v1/workspaces/" + $("Extract Dispatch Context").item.json.config.plane_workspace_slug + "/projects/" + $("Extract Dispatch Context").item.json.plane_project_id + "/states/" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] }
    }
  }
});

const resolveBuildingState = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Building State',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Extract Dispatch Context').item.json;
const states = Array.isArray($json.results) ? $json.results : (Array.isArray($json) ? $json : []);
const state = states.find((item) => String(item.name || '').toLowerCase() === String(original.config.plane_building_state_name || 'Building').toLowerCase());
return { json: { ...original, plane_state_id: state?.id || original.config.plane_building_state_id } };
\`
    }
  }
});

const movePlaneBuilding = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Move Plane to Building',
    alwaysOutputData: true,
    continueOnFail: true,
    credentials: { httpHeaderAuth: newCredential('${planeApiCredential}') },
    parameters: {
      method: 'PATCH',
      url: expr('{{ $json.config.plane_api_base_url + "/api/v1/workspaces/" + $json.config.plane_workspace_slug + "/projects/" + $json.plane_project_id + "/work-items/" + $json.plane_issue_id + "/" }}'),
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

const respondDispatched = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Dispatched', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "codex_requested", issue_number: $("Extract Dispatch Context").item.json.issue_number, plane_issue_id: $("Extract Dispatch Context").item.json.plane_issue_id } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Ignored', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "ignored_issue_not_eligible", github_action: $json.action, issue_number: $json.issue_number || "" } }}'), options: { responseCode: 200 } } } });

export default workflow('github-issue-codex-dispatch', 'GitHub Issue to Codex Dispatch')
  .add(githubIssueWebhook)
  .to(config)
  .to(extract)
  .to(shouldDispatch
    .onTrue(claimIssue.to(requestCodex).to(listPlaneBuildingStates).to(resolveBuildingState).to(movePlaneBuilding).to(respondDispatched))
    .onFalse(respondIgnored));
`;

const codexPrWatchdogWorkflow = `
import { workflow, node, trigger, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const manual = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Manual Watchdog Run' }
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

const testWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Watchdog Test Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'codex-pr-watchdog-test',
      responseMode: 'onReceived'
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
          { id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", stale_minutes: 60, slack_alert_channel: "#workflow-builder", public_n8n_base_url: "https://n8n.tradecredit.agency" } }}') }
        ]
      }
    }
  }
});

const buildSearch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Stale Issue Search',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || {};
const staleMinutes = Number(body.stale_minutes ?? $json.stale_minutes ?? config.stale_minutes ?? 60);
const staleBeforeIso = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
return { json: { ...$json, config: { ...config, stale_minutes: staleMinutes }, stale_before_iso: staleBeforeIso } };
\`
    }
  }
});

const searchStaleIssues = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Search Stale Codex Issues',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/search/issues?q=" + encodeURIComponent("repo:" + $json.config.github_owner + "/" + $json.config.github_repo + " is:issue is:open label:plane label:codex-ready label:automation label:codex-in-progress -label:codex-pr-open -label:done -label:blocked updated:<" + $json.stale_before_iso) + "&sort=updated&order=asc&per_page=1" }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const extractCandidate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Watchdog Candidate',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Build Stale Issue Search').item.json;
const issue = Array.isArray($json.items) ? $json.items[0] : null;
if (!issue) {
  return { json: { ...original, has_candidate: false } };
}
const text = issue.body || '';
const planeIssueId = text.match(/plane_issue_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeProjectId = text.match(/plane_project_id:\\\\s*([A-Za-z0-9_-]+)/i)?.[1] || '';
const planeUrl = text.match(/plane_url:\\\\s*(\\\\S+)/i)?.[1] || '';
return {
  json: {
    ...original,
    has_candidate: true,
    issue_number: String(issue.number || ''),
    issue_url: issue.html_url || '',
    issue_title: issue.title || '',
    issue_updated_at: issue.updated_at || '',
    plane_issue_id: planeIssueId,
    plane_project_id: planeProjectId,
    plane_url: planeUrl,
  },
};
\`
    }
  }
});

const hasCandidate = ifElse({
  version: 2.3,
  config: {
    name: 'Has Stale Candidate?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.has_candidate) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const searchPrs = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Search PRs for Plane Issue',
    parameters: {
      method: 'GET',
      url: expr('{{ "https://api.github.com/search/issues?q=" + encodeURIComponent("repo:" + $json.config.github_owner + "/" + $json.config.github_repo + " type:pr is:open plane_issue_id: " + $json.plane_issue_id) + "&sort=created&order=desc&per_page=5" }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] }
    }
  }
});

const resolvePr = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve PR Watchdog Result',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const original = $('Extract Watchdog Candidate').item.json;
const prs = (Array.isArray($json.items) ? $json.items : []).filter((item) => item.pull_request);
const pr = prs[0];
const hasPr = Boolean(pr?.html_url);
const slackMessage = [
  ':warning: Codex PR publication blocked',
  'GitHub issue: ' + original.issue_url,
  'Plane: ' + (original.plane_url || 'not provided'),
  'Reason: Codex was requested and the issue stayed codex-in-progress for more than ' + (original.config.stale_minutes || 60) + ' minutes, but no open PR with the Plane metadata was found.',
  'Next action: open the Codex task link from the issue comments, fix the Codex GitHub PR publication setting, then re-dispatch or create the PR manually.'
].join('\\\\n');
return { json: { ...original, has_open_pr: hasPr, pr_url: pr?.html_url || '', slack_message: slackMessage } };
\`
    }
  }
});

const hasOpenPr = ifElse({
  version: 2.3,
  config: {
    name: 'Open PR Found?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.has_open_pr) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const markPrOpen = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Mark Issue PR Open',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'edit',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($json.issue_number) }}'),
      editFields: { labels: [{ label: 'plane' }, { label: 'codex-ready' }, { label: 'automation' }, { label: 'codex-in-progress' }, { label: 'codex-pr-open' }] }
    }
  }
});

const commentMissingPr = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Comment Missing PR Incident',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'createComment',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($json.issue_number) }}'),
      body: expr('{{ "Codex PR publication watchdog marked this issue blocked. Codex was requested, but no open PR containing plane_issue_id " + ($json.plane_issue_id || "unknown") + " was found after " + ($json.config.stale_minutes || 60) + " minutes. Check the Codex task link in the issue comments, repair the connector PR publication path, then re-dispatch or create the PR manually." }}')
    }
  }
});

const markBlocked = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Mark Issue Blocked',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'edit',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($("Resolve PR Watchdog Result").item.json.issue_number) }}'),
      editFields: { labels: [{ label: 'plane' }, { label: 'codex-ready' }, { label: 'automation' }, { label: 'codex-in-progress' }, { label: 'codex-pr-missing' }, { label: 'blocked' }] }
    }
  }
});

const restoreBlockedContext = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Restore Blocked Slack Context',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'slack-message', name: 'slack_message', type: 'string', value: expr('{{ $("Resolve PR Watchdog Result").item.json.slack_message }}') },
          { id: 'slack-channel', name: 'slack_alert_channel', type: 'string', value: expr('{{ $("Resolve PR Watchdog Result").item.json.config.slack_alert_channel }}') }
        ]
      }
    }
  }
});

const slackBlocked = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send Slack Missing PR Alert',
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

const noStaleCandidate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'No Stale Candidate',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: 'return { json: { ...$json, ok: true, action: "no_stale_codex_issues" } };'
    }
  }
});

export default workflow('codex-pr-publication-watchdog', 'Codex PR Publication Watchdog')
  .add(manual)
  .to(config)
  .add(schedule)
  .to(config)
  .add(testWebhook)
  .to(config)
  .to(buildSearch)
  .to(searchStaleIssues)
  .to(extractCandidate)
  .to(hasCandidate
    .onTrue(searchPrs.to(resolvePr).to(hasOpenPr
      .onTrue(markPrOpen)
      .onFalse(commentMissingPr.to(markBlocked).to(restoreBlockedContext).to(slackBlocked))))
    .onFalse(noStaleCandidate));
`;

const slackApprovalWorkflow = `
import { workflow, node, newCredential, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const slackWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'Slack Approval Webhook', parameters: { httpMethod: 'POST', path: 'slack-agent-approval', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true } } }
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'CONFIG',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [{ id: 'config-object', name: 'config', type: 'object', value: expr('{{ { github_owner: "choicedrum-crypto", github_repo: "agentic-buildout-starter", merge_method: "squash", plane_api_base_url: "https://api.plane.so", plane_workspace_slug: "tcia", plane_approved_state_name: "Approved", plane_approved_state_id: "0948b422-5c0c-4c37-b34d-0a358e156a6f", plane_changes_state_name: "Changes Requested", plane_blocked_state_name: "Blocked", plane_blocked_state_id: "8ea8d880-15b2-4201-8fbc-358ba54e5b54" } }}') }] }
    }
  }
});

const extract = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Slack Decision',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: \`
const config = $json.config || {};
const body = $json.body || $json;
let payload = body.payload || body;
if (typeof payload === 'string') {
  try { payload = JSON.parse(payload); } catch { payload = {}; }
}
const action = payload.actions?.[0] || {};
let value = action.value || body.value || '{}';
try { value = typeof value === 'string' ? JSON.parse(value) : value; } catch { value = {}; }
const decision = value.decision || action.action_id || body.decision || '';
const approved = decision === 'approve';
const requestChanges = decision === 'request_changes';
const blocked = decision === 'block';
return {
  json: {
    ...$json,
    config,
    decision,
    approved,
    request_changes: requestChanges,
    blocked,
    pr_number: String(value.pr_number || body.pr_number || ''),
    plane_issue_id: value.plane_issue_id || body.plane_issue_id || '',
    plane_project_id: value.plane_project_id || body.plane_project_id || '',
    requested_by: payload.user?.username || payload.user?.name || payload.user?.id || '',
    revision_request: value.revision_request || body.revision_request || 'Changes requested from Slack approval action.',
    target_state_name: approved ? config.plane_approved_state_name : (blocked ? config.plane_blocked_state_name : config.plane_changes_state_name)
  }
};
\`
    }
  }
});

const validDecision = ifElse({
  version: 2.3,
  config: {
    name: 'Valid Slack Decision?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String(Boolean($json.pr_number && ($json.approved || $json.request_changes || $json.blocked))) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const approvedDecision = ifElse({
  version: 2.3,
  config: {
    name: 'Approved?',
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ String($json.approved) }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'true' }], combinator: 'and' }
    }
  }
});

const mergePr = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Merge Approved PR',
    credentials: { httpHeaderAuth: newCredential('${githubHttpCredential}') },
    parameters: {
      method: 'PUT',
      url: expr('{{ "https://api.github.com/repos/" + $json.config.github_owner + "/" + $json.config.github_repo + "/pulls/" + $json.pr_number + "/merge" }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }, { name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { merge_method: $json.config.merge_method || "squash", commit_title: "Merge approved agentic PR #" + $json.pr_number } }}')
    }
  }
});

const commentPrDecision = node({
  type: 'n8n-nodes-base.github',
  version: 1.1,
  config: {
    name: 'Comment PR Decision',
    credentials: { githubApi: newCredential('${githubCredential}') },
    parameters: {
      resource: 'issue',
      operation: 'createComment',
      authentication: 'accessToken',
      owner: { __rl: true, mode: 'name', value: 'choicedrum-crypto' },
      repository: { __rl: true, mode: 'name', value: 'agentic-buildout-starter' },
      issueNumber: expr('{{ Number($json.pr_number) }}'),
      body: expr('{{ $json.request_changes ? "/codex revise\\\\n" + $json.revision_request : "Blocked from Slack approval action by " + ($json.requested_by || "unknown") }}')
    }
  }
});

const respondApproved = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Approved', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: "approved_and_merge_requested", pr_number: $("Extract Slack Decision").item.json.pr_number } }}'), options: { responseCode: 200 } } } });
const respondQueued = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Revision Or Block', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: true, action: $("Extract Slack Decision").item.json.request_changes ? "revision_requested" : "blocked", pr_number: $("Extract Slack Decision").item.json.pr_number } }}'), options: { responseCode: 200 } } } });
const respondIgnored = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5, config: { name: 'Respond Invalid Decision', parameters: { respondWith: 'json', responseBody: expr('{{ { ok: false, action: "invalid_slack_decision" } }}'), options: { responseCode: 400 } } } });

export default workflow('slack-approval-to-merge', 'Slack Approval to Merge')
  .add(slackWebhook)
  .to(config)
  .to(extract)
  .to(validDecision
    .onTrue(approvedDecision
      .onTrue(mergePr.to(respondApproved))
      .onFalse(commentPrDecision.to(respondQueued)))
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
    name: 'GitHub Issue to Codex Dispatch',
    code: codexDispatchWorkflow,
    description: 'Claims Codex-ready GitHub issues from Plane and dispatches them to the Codex build entrypoint.',
  },
  {
    name: 'Codex PR Publication Watchdog',
    workflowId: 'nRQEyuJdrS1u0cFC',
    code: codexPrWatchdogWorkflow,
    description: 'Checks Codex-dispatched issues for missing PR publication and sends a blocked Slack alert when no PR appears.',
  },
  {
    name: 'Slack Approval to Merge',
    code: slackApprovalWorkflow,
    description: 'Receives Slack approval decisions, merges approved PRs, or queues requested changes.',
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
  {
    name: 'Email Categorizer Correction Review',
    description: 'Nightly dry-run companion that records manual Outlook category corrections against Email Categorizer audit rows.',
    restWorkflowBuilder: buildEmailCorrectionReviewRestWorkflow,
    createAndSwapRest: true,
  },
  {
    name: 'Email Categorizer Rule Suggestion',
    description: 'Weekly companion that turns new manual correction rows into a GitHub/Codex rule-update request.',
    restWorkflowBuilder: buildEmailRuleSuggestionRestWorkflow,
    createAndSwapRest: true,
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
  if (item.createAndSwapRest) {
    if (validateOnly) {
      console.log(`validated ${item.name}`);
      continue;
    }

    const publishToken = (env.GITHUB_SHA || new Date().toISOString()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const publishedName = `${item.name} - Published ${publishToken}`;
    const workflowId = await createRestWorkflowViaRest(item.name, publishedName, item.restWorkflowBuilder);
    console.log(`created-and-swapped ${item.name} via REST as ${publishedName} (${workflowId})`);
    continue;
  }

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
      console.warn(`falling back to n8n REST workflow create for ${publishedName}`);
      createdWorkflowId = await createEmailWorkflowViaRest(publishedName);
      console.log(`created-and-swapped ${item.name} via REST as ${publishedName} (${createdWorkflowId})`);
      continue;
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
