const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 4000;
const HOST = '127.0.0.1';
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const REPORTS_DIR = path.join(ROOT_DIR, 'reports');

fs.mkdirSync(REPORTS_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

function parsePositiveInt(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 100000) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return number;
}

function parseDuration(value, fieldName) {
  const text = String(value || '').trim();
  if (!/^\d+(ms|s|m|h)$/.test(text)) {
    throw new Error(`${fieldName} must be a k6 duration like 30s, 5m, or 1h.`);
  }
  return text;
}

function parseNonNegativeNumber(value, fieldName, defaultValue = 1) {
  const raw = value === undefined || value === null || value === '' ? defaultValue : value;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName} must be a number greater than or equal to 0.`);
  }
  return number;
}

function parseJsonObject(value, fieldName, fallback = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${fieldName} must be valid JSON object syntax.`);
  }
}

function parseOptionalJson(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }
}

function validateUrl(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${fieldName} is required.`);
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${fieldName} must be a valid http:// or https:// URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${fieldName} must use http:// or https://.`);
  }

  return url.toString().replace(/\/$/, '');
}

function validatePathOrUrl(value, fieldName, { required = true } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    if (required) {
      throw new Error(`${fieldName} is required.`);
    }
    return '';
  }

  if (/^https?:\/\//i.test(text)) {
    return validateUrl(text, fieldName);
  }

  if (!text.startsWith('/')) {
    throw new Error(`${fieldName} must start with / or be a full http(s) URL.`);
  }

  return text;
}

function validateTokenPath(value) {
  const text = String(value || 'data.token').trim();
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(text)) {
    throw new Error('Token JSON path may only contain dot properties and numeric indexes, for example data.token or data.items[0].token.');
  }
  return text;
}

function validateMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    throw new Error('Method must be GET, POST, PUT, or DELETE.');
  }
  return method;
}

function buildK6Script(config) {
  return `
import http from 'k6/http';
import { check } from 'k6';
import { sleep } from 'k6';

const config = ${JSON.stringify(config, null, 2)};

export const options = {
  stages: [
    { duration: config.rampUp, target: config.vus },
    { duration: config.duration, target: config.vus },
    { duration: config.rampDown, target: 0 },
  ],
};

function joinUrl(baseUrl, target) {
  if (/^https?:\\/\\//i.test(target)) {
    return target;
  }
  return baseUrl.replace(/\\/$/, '') + '/' + target.replace(/^\\//, '');
}

function readPath(source, tokenPath) {
  return tokenPath.replace(/\\[(\\d+)\\]/g, '.$1').split('.').reduce((value, key) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    return value[key];
  }, source);
}

function requestParams(extraHeaders = {}) {
  return {
    headers: Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      config.headers,
      extraHeaders
    ),
  };
}

export function setup() {
  if (!config.authEnabled) {
    return { token: '' };
  }

  const response = http.post(
    joinUrl(config.baseUrl, config.loginUrl),
    JSON.stringify({ email: config.email, password: config.password }),
    requestParams()
  );

  check(response, {
    'login returned 2xx': (res) => res.status >= 200 && res.status < 300,
  });

  let json;
  try {
    json = response.json();
  } catch (error) {
    throw new Error('Login response was not valid JSON.');
  }

  const token = readPath(json, config.tokenPath);
  if (!token || typeof token !== 'string') {
    throw new Error('Could not find token at JSON path: ' + config.tokenPath);
  }

  return { token };
}

export default function (data) {
  const token = data && data.token ? data.token : '';
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const params = requestParams(headers);
  const url = joinUrl(config.baseUrl, config.endpoint);
  let response;

  if (config.method === 'GET') {
    response = http.get(url, params);
  } else if (config.method === 'POST') {
    response = http.post(url, JSON.stringify(config.body || {}), params);
  } else if (config.method === 'PUT') {
    response = http.put(url, JSON.stringify(config.body || {}), params);
  } else if (config.method === 'DELETE') {
    response = http.del(url, JSON.stringify(config.body || {}), params);
  }

  check(response, {
    'endpoint returned 2xx': (res) => res.status >= 200 && res.status < 300,
  });

  // Pacing prevents each virtual user from looping as fast as possible, which
  // helps model realistic traffic instead of accidentally creating max stress.
  if (Number(config.sleep) > 0) {
    sleep(Number(config.sleep || 1));
  }
}
`.trimStart();
}

function buildOutputSummary(config) {
  const pacingMode = Number(config.sleep) === 0 ? 'stress' : 'realistic';
  return [
    '--- Test summary ---',
    `VUs: ${config.vus}`,
    `Duration: ${config.duration}`,
    `Sleep used: ${config.sleep}s`,
    `Estimated request pacing mode: ${pacingMode}`,
    '',
  ].join('\n');
}

function validatePayload(payload) {
  const authEnabled = Boolean(payload.authEnabled);
  const config = {
    baseUrl: validateUrl(payload.baseUrl, 'Base URL'),
    endpoint: validatePathOrUrl(payload.endpoint, 'Endpoint'),
    method: validateMethod(payload.method),
    authEnabled,
    loginUrl: authEnabled ? validatePathOrUrl(payload.loginUrl, 'Login URL') : '',
    email: authEnabled ? String(payload.email || '').trim() : '',
    password: authEnabled ? String(payload.password || '') : '',
    tokenPath: validateTokenPath(payload.tokenPath),
    headers: parseJsonObject(payload.headers, 'Headers JSON'),
    body: parseOptionalJson(payload.body, 'Body JSON'),
    vus: parsePositiveInt(payload.vus, 'VUs'),
    rampUp: parseDuration(payload.rampUp, 'Ramp up'),
    duration: parseDuration(payload.duration, 'Duration'),
    rampDown: parseDuration(payload.rampDown, 'Ramp down'),
    sleep: parseNonNegativeNumber(payload.sleep, 'Sleep Between Requests', 1),
  };

  if (authEnabled && (!config.email || !config.password)) {
    throw new Error('Email and password are required when auth is enabled.');
  }

  if (config.method !== 'GET' && config.body === null) {
    config.body = {};
  }

  return config;
}

app.post('/run-test', (req, res) => {
  let config;
  try {
    config = validatePayload(req.body || {});
  } catch (error) {
    return res.status(400).json({
      success: false,
      output: '',
      error: error.message,
      reportFile: null,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${Math.random().toString(16).slice(2)}`;
  const scriptFile = path.join(REPORTS_DIR, `test-${id}.js`);
  const reportName = `report-${id}.html`;
  const reportFile = path.join(REPORTS_DIR, reportName);

  fs.writeFileSync(scriptFile, buildK6Script(config), 'utf8');

  let output = '';
  let errorOutput = '';
  const child = spawn('k6', ['run', scriptFile], {
    cwd: ROOT_DIR,
    shell: false,
    env: {
      ...process.env,
      K6_WEB_DASHBOARD: 'true',
      K6_WEB_DASHBOARD_EXPORT: reportFile,
    },
  });

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });

  child.on('error', (error) => {
    fs.rm(scriptFile, { force: true }, () => {});
    res.status(500).json({
      success: false,
      output,
      error: error.code === 'ENOENT'
        ? 'k6 was not found. Install k6 and make sure it is available on your PATH.'
        : error.message,
      reportFile: null,
    });
  });

  child.on('close', (code) => {
    fs.rm(scriptFile, { force: true }, () => {});
    const hasReport = fs.existsSync(reportFile);
    res.status(code === 0 ? 200 : 500).json({
      success: code === 0,
      output: buildOutputSummary(config) + output,
      error: errorOutput || (code === 0 ? '' : `k6 exited with code ${code}.`),
      reportFile: hasReport ? `/reports/${reportName}` : null,
    });
  });
});

app.get('/reports/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^report-[A-Za-z0-9_.-]+\.html$/.test(file)) {
    return res.status(400).send('Invalid report file.');
  }

  const reportPath = path.join(REPORTS_DIR, file);
  if (!reportPath.startsWith(REPORTS_DIR) || !fs.existsSync(reportPath)) {
    return res.status(404).send('Report not found.');
  }

  res.sendFile(reportPath);
});

app.listen(PORT, HOST, () => {
  console.log(`Load tester app running at http://localhost:${PORT}`);
});
