const form = document.querySelector('#test-form');
const output = document.querySelector('#output');
const reportLink = document.querySelector('#reportLink');
const runButton = document.querySelector('#runButton');
const statusText = document.querySelector('#status');
const preset = document.querySelector('#preset');
const modePreset = document.querySelector('#modePreset');

const fields = {
  baseUrl: document.querySelector('#baseUrl'),
  endpoint: document.querySelector('#endpoint'),
  method: document.querySelector('#method'),
  authEnabled: document.querySelector('#authEnabled'),
  loginUrl: document.querySelector('#loginUrl'),
  email: document.querySelector('#email'),
  password: document.querySelector('#password'),
  tokenPath: document.querySelector('#tokenPath'),
  vus: document.querySelector('#vus'),
  rampUp: document.querySelector('#rampUp'),
  duration: document.querySelector('#duration'),
  rampDown: document.querySelector('#rampDown'),
  sleep: document.querySelector('#sleep'),
  headers: document.querySelector('#headers'),
  body: document.querySelector('#body'),
};

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading ? 'Running...' : 'Run Test';
  statusText.textContent = isLoading ? 'Running k6 test' : '';
  statusText.classList.remove('error');
}

function readJson(text, label) {
  const value = text.trim();
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

preset.addEventListener('change', () => {
  if (!preset.value) {
    return;
  }

  const [method, ...endpointParts] = preset.value.split(' ');
  fields.method.value = method;
  fields.endpoint.value = endpointParts.join(' ');
});

modePreset.addEventListener('change', () => {
  if (modePreset.value === '') {
    return;
  }

  fields.sleep.value = modePreset.value;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  reportLink.classList.add('hidden');
  reportLink.href = '#';

  let payload;
  try {
    payload = {
      baseUrl: fields.baseUrl.value,
      endpoint: fields.endpoint.value,
      method: fields.method.value,
      authEnabled: fields.authEnabled.checked,
      loginUrl: fields.loginUrl.value,
      email: fields.email.value,
      password: fields.password.value,
      tokenPath: fields.tokenPath.value || 'data.token',
      vus: Number(fields.vus.value),
      rampUp: fields.rampUp.value,
      duration: fields.duration.value,
      rampDown: fields.rampDown.value,
      sleep: Number(fields.sleep.value),
      headers: readJson(fields.headers.value, 'Headers JSON'),
      body: readJson(fields.body.value, 'Body JSON'),
    };
  } catch (error) {
    output.textContent = error.message;
    statusText.textContent = 'Fix JSON and try again';
    statusText.classList.add('error');
    return;
  }

  setLoading(true);
  output.textContent = 'Starting test...';

  try {
    const response = await fetch('/run-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();

    output.textContent = [
      result.output || '',
      result.error ? `\n--- stderr / error ---\n${result.error}` : '',
    ].join('').trim() || 'No output returned.';

    if (result.reportFile) {
      reportLink.href = result.reportFile;
      reportLink.classList.remove('hidden');
    }

    statusText.textContent = result.success ? 'Finished' : 'Failed';
    statusText.classList.toggle('error', !result.success);
  } catch (error) {
    output.textContent = error.message;
    statusText.textContent = 'Request failed';
    statusText.classList.add('error');
  } finally {
    setLoading(false);
  }
});
