// dv-native UI: four steps — function, check, environment, deploy. No third-party code; talks only to this local server.

const sSessionKey = 'dvNativeSession';
const sThemeKey = 'dvNativeTheme';

const eForm = document.getElementById('spec-form');
const eFormula = document.getElementById('formula');
const eParamRows = document.getElementById('param-rows');
const eJsonView = document.getElementById('json-view');
const eLoadError = document.getElementById('load-error');
const eCheckBadge = document.getElementById('check-badge');
const eCheckStatus = document.getElementById('check-status');
const eIssueList = document.getElementById('issue-list');
const eAccountStatus = document.getElementById('account-status');
const eSignInLink = document.getElementById('sign-in-link');
const eProfileField = document.getElementById('profile-field');
const eProfileSelect = document.getElementById('profile-select');
const eConnectionPill = document.getElementById('connection-pill');
const eLoginButton = document.getElementById('btn-login');
const eReconnectButton = document.getElementById('btn-reconnect');
const eCancelLoginButton = document.getElementById('btn-cancel-login');
const eRemoveProfileButton = document.getElementById('btn-remove-profile');
const eEnvSection = document.getElementById('env-section');
const eEnvSearch = document.getElementById('env-search');
const eEnvStatus = document.getElementById('env-status');
const eEnvList = document.getElementById('env-list');
const eDeploySummary = document.getElementById('deploy-summary');
const eDeployStatus = document.getElementById('deploy-status');
const eDeploySteps = document.getElementById('deploy-steps');
const eSolutionLink = document.getElementById('solution-link');
const eConfirmDialog = document.getElementById('confirm-dialog');

const sSignInOrigin = 'https://login.microsoftonline.com/';
const sMakerPortalOrigin = 'https://make.powerapps.com/';

const oState = {
  oMeta: { parameterTypes: [], messages: [], stages: [], examples: [] },
  bUniqueNameTouched: false,
  sLastCheckedText: '',
  oLastCheck: null,
  oSession: null,
  aEnvironments: [],
  bEnvironmentsLoaded: false,
  bEnvironmentsLoading: false,
  sEnvironmentUrl: '',
  iCheckTimer: 0,
  iSessionTimer: 0,
  iDeployTimer: 0,
  iDeployStartedAt: 0,
  bDeploying: false,
};

// ---------- session + API ----------

function getSessionToken() {
  const oParams = new URLSearchParams(window.location.search);
  const sFromUrl = oParams.get('session');
  if (sFromUrl) {
    sessionStorage.setItem(sSessionKey, sFromUrl);
    window.history.replaceState(null, '', window.location.pathname);
  }
  return sessionStorage.getItem(sSessionKey) ?? '';
}

const sSessionToken = getSessionToken();

async function callApi(sPath, oBody) {
  const oInit = { method: oBody === undefined ? 'GET' : 'POST', headers: { 'X-DV-Session': sSessionToken } };
  if (oBody !== undefined) {
    oInit.headers['Content-Type'] = 'application/json';
    oInit.body = JSON.stringify(oBody);
  }
  const oResponse = await fetch(sPath, oInit);
  const oData = await oResponse.json().catch(() => ({}));
  if (!oResponse.ok) {
    const sReason = oData.error ?? (Array.isArray(oData.reasonCodes) ? oData.reasonCodes.join(', ') : `HTTP ${oResponse.status}`);
    throw new Error(sReason);
  }
  return oData;
}

// ---------- small DOM helpers ----------

function createElement(sTag, sClassName, sText) {
  const eElement = document.createElement(sTag);
  if (sClassName) eElement.className = sClassName;
  if (sText !== undefined) eElement.textContent = sText;
  return eElement;
}

function fillSelect(eSelect, aValues) {
  eSelect.replaceChildren(...aValues.map((sValue) => new Option(sValue, sValue)));
}

function field(sName) {
  return eForm.elements.namedItem(sName);
}

/** Status text; bBusy shows a spinner so long waits don't look frozen. */
function setStatus(eElement, sText, bBusy = false) {
  eElement.textContent = sText;
  eElement.classList.toggle('busy', bBusy);
}

function formatElapsed(iMilliseconds) {
  const iSeconds = Math.floor(iMilliseconds / 1000);
  return `${Math.floor(iSeconds / 60)}:${String(iSeconds % 60).padStart(2, '0')}`;
}

// ---------- theme ----------

function applyTheme(sTheme) {
  document.documentElement.dataset.theme = sTheme;
  localStorage.setItem(sThemeKey, sTheme);
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

// ---------- steps ----------

function showStep(sStep) {
  document.querySelectorAll('.step').forEach((eButton) => eButton.classList.toggle('active', eButton.dataset.step === sStep));
  document.querySelectorAll('main > .panel').forEach((ePanel) => {
    ePanel.hidden = ePanel.id !== `panel-${sStep}`;
  });
  if (sStep === '2') runCheck();
  if (sStep === '3') refreshSession();
  if (sStep === '4') renderDeploySummary();
}

// ---------- step 1: spec <-> form ----------

function addParameterRow(oParameter = { name: '', direction: 'input', type: 'String' }) {
  const eRow = createElement('tr');
  const eName = createElement('input');
  eName.value = oParameter.name;
  eName.setAttribute('aria-label', 'Parameter name');
  const eDirection = createElement('select');
  fillSelect(eDirection, ['input', 'output']);
  eDirection.value = oParameter.direction;
  eDirection.setAttribute('aria-label', 'Direction');
  const eType = createElement('select');
  fillSelect(eType, oState.oMeta.parameterTypes);
  eType.value = oParameter.type;
  eType.setAttribute('aria-label', 'Type');
  const eRemove = createElement('button', 'ghost', '✕');
  eRemove.type = 'button';
  eRemove.title = 'Remove parameter';
  eRemove.addEventListener('click', () => {
    eRow.remove();
    onSpecChanged();
  });
  [eName, eDirection, eType, eRemove].forEach((eControl) => {
    const eCell = createElement('td');
    eCell.append(eControl);
    eRow.append(eCell);
  });
  eParamRows.append(eRow);
}

function readParameters() {
  return [...eParamRows.querySelectorAll('tr')].map((eRow) => {
    const [eName, eDirection, eType] = eRow.querySelectorAll('input, select');
    return { name: eName.value.trim(), direction: eDirection.value, type: eType.value };
  });
}

function readSpecFromForm() {
  const sKind = field('kind').value;
  const sOptionPrefix = field('publisherOptionValuePrefix').value.trim();
  const oSpec = {
    schemaVersion: 'dv-native.plugin/v1',
    kind: sKind,
    uniqueName: field('uniqueName').value.trim(),
    displayName: field('displayName').value.trim(),
  };
  const sDescription = field('description').value.trim();
  if (sDescription) oSpec.description = sDescription;
  oSpec.solution = { uniqueName: field('solutionUniqueName').value.trim() };
  const sSolutionDisplay = field('solutionDisplayName').value.trim();
  const sVersion = field('solutionVersion').value.trim();
  if (sSolutionDisplay) oSpec.solution.displayName = sSolutionDisplay;
  if (sVersion) oSpec.solution.version = sVersion;
  oSpec.solution.publisher = {
    uniqueName: field('publisherUniqueName').value.trim(),
    prefix: field('publisherPrefix').value.trim(),
    optionValuePrefix: /^\d+$/.test(sOptionPrefix) ? Number(sOptionPrefix) : sOptionPrefix,
  };
  if (sKind === 'instant') {
    oSpec.parameters = readParameters();
  } else {
    oSpec.trigger = { table: field('triggerTable').value.trim(), message: field('triggerMessage').value, stage: field('triggerStage').value };
  }
  oSpec.tables = field('tables').value.split(',').map((sTable) => sTable.trim()).filter((sTable) => sTable.length > 0);
  oSpec.formula = eFormula.value;
  return oSpec;
}

function writeSpecToForm(oSpec) {
  const oSolution = oSpec.solution ?? {};
  const oPublisher = oSolution.publisher ?? {};
  eForm.querySelectorAll('input[name="kind"]').forEach((eRadio) => {
    eRadio.checked = eRadio.value === (oSpec.kind === 'automated' ? 'automated' : 'instant');
  });
  field('displayName').value = oSpec.displayName ?? '';
  field('uniqueName').value = oSpec.uniqueName ?? '';
  field('description').value = oSpec.description ?? '';
  field('solutionUniqueName').value = oSolution.uniqueName ?? '';
  field('solutionDisplayName').value = oSolution.displayName ?? '';
  field('solutionVersion').value = oSolution.version ?? '';
  field('publisherUniqueName').value = oPublisher.uniqueName ?? '';
  field('publisherPrefix').value = oPublisher.prefix ?? '';
  field('publisherOptionValuePrefix').value = oPublisher.optionValuePrefix ?? '';
  eParamRows.replaceChildren();
  (oSpec.parameters ?? []).forEach((oParameter) => addParameterRow(oParameter));
  field('triggerTable').value = oSpec.trigger?.table ?? '';
  field('triggerMessage').value = oSpec.trigger?.message ?? oState.oMeta.messages[0] ?? '';
  field('triggerStage').value = oSpec.trigger?.stage ?? oState.oMeta.stages[0] ?? '';
  field('tables').value = (oSpec.tables ?? []).join(', ');
  eFormula.value = oSpec.formula ?? '';
  oState.bUniqueNameTouched = true;
  onSpecChanged();
}

function suggestUniqueName() {
  if (oState.bUniqueNameTouched) return;
  const sPrefix = field('publisherPrefix').value.trim();
  const sName = field('displayName').value.replace(/[^A-Za-z0-9]/g, '');
  field('uniqueName').value = sPrefix && sName ? `${sPrefix}_${sName}` : '';
}

function syncKindVisibility() {
  const bAutomated = field('kind').value === 'automated';
  document.getElementById('instant-fields').hidden = bAutomated;
  document.getElementById('automated-fields').hidden = !bAutomated;
}

function specText() {
  return `${JSON.stringify(readSpecFromForm(), null, 2)}\n`;
}

function onSpecChanged() {
  syncKindVisibility();
  if (!eJsonView.hidden) eJsonView.textContent = specText();
  eCheckBadge.textContent = '…';
  eCheckBadge.className = 'badge';
  window.clearTimeout(oState.iCheckTimer);
  oState.iCheckTimer = window.setTimeout(runCheck, 500);
}

async function newSpec(sKind) {
  const sName = sKind === 'automated' ? 'automated.plugin.json' : 'instant.plugin.json';
  await loadExample(sName);
}

async function loadExample(sName) {
  try {
    const oExample = await callApi(`/api/examples/${encodeURIComponent(sName)}`);
    loadSpecText(oExample.content);
  } catch (oError) {
    showLoadError(`Could not load the example: ${oError.message}`);
  }
}

function loadSpecText(sText) {
  try {
    const oSpec = JSON.parse(sText);
    if (oSpec === null || typeof oSpec !== 'object' || oSpec.schemaVersion !== 'dv-native.plugin/v1') {
      showLoadError('This file is not a dv-native.plugin/v1 spec.');
      return;
    }
    showLoadError('');
    writeSpecToForm(oSpec);
  } catch {
    showLoadError('This file is not valid JSON.');
  }
}

function showLoadError(sMessage) {
  eLoadError.textContent = sMessage;
  eLoadError.hidden = sMessage === '';
}

function openFile(eInput) {
  const oFile = eInput.files?.[0];
  if (!oFile) return;
  oFile.text().then(loadSpecText).catch(() => showLoadError('The file could not be read.'));
  eInput.value = '';
}

function downloadSpec() {
  const oSpec = readSpecFromForm();
  const oBlob = new Blob([specText()], { type: 'application/json' });
  const eLink = createElement('a');
  eLink.href = URL.createObjectURL(oBlob);
  eLink.download = `${oSpec.uniqueName || 'plugin'}.plugin.json`;
  eLink.click();
  URL.revokeObjectURL(eLink.href);
}

function updateCursorPosition() {
  const sBefore = eFormula.value.slice(0, eFormula.selectionStart);
  const aLines = sBefore.split('\n');
  document.getElementById('cursor-pos').textContent = `Ln ${aLines.length}, Col ${aLines.at(-1).length + 1}`;
}

function jumpToFormula(iLine, iColumn) {
  showStep('1');
  const aLines = eFormula.value.split('\n');
  const iOffset = aLines.slice(0, iLine - 1).reduce((iTotal, sLine) => iTotal + sLine.length + 1, 0) + iColumn - 1;
  eFormula.focus();
  eFormula.setSelectionRange(iOffset, iOffset + 1);
  updateCursorPosition();
}

// ---------- step 2: check ----------

async function runCheck() {
  const sText = specText();
  if (sText === oState.sLastCheckedText && oState.oLastCheck) {
    renderCheck(oState.oLastCheck);
    return;
  }
  eCheckStatus.textContent = 'Checking…';
  try {
    const oResult = await callApi('/api/studio/check', { spec: sText });
    oState.sLastCheckedText = sText;
    oState.oLastCheck = oResult;
    renderCheck(oResult);
  } catch (oError) {
    eCheckStatus.textContent = `Check failed: ${oError.message}`;
  }
}

function renderCheck(oResult) {
  const iErrors = oResult.issues.filter((oIssue) => oIssue.severity === 'error').length;
  const iWarnings = oResult.issues.length - iErrors;
  eCheckBadge.textContent = oResult.ok ? (iWarnings > 0 ? `${iWarnings}⚠` : '✓') : `${iErrors}✕`;
  eCheckBadge.className = `badge ${oResult.ok ? (iWarnings > 0 ? 'warn' : 'ok') : 'bad'}`;
  eCheckStatus.textContent = oResult.ok ? `Passed${iWarnings > 0 ? ` with ${iWarnings} warning(s)` : ''}.` : `${iErrors} error(s) must be fixed before deploy.`;
  eIssueList.replaceChildren(
    ...oResult.issues.map((oIssue) => {
      const eItem = createElement('li', oIssue.severity);
      const sWhere = oIssue.line !== undefined ? `Ln ${oIssue.line}, Col ${oIssue.column}` : (oIssue.path ?? '');
      eItem.append(createElement('strong', '', oIssue.severity === 'error' ? 'Error' : 'Warning'), createElement('span', 'muted', ` ${sWhere} `), createElement('span', '', oIssue.message));
      if (oIssue.line !== undefined) {
        eItem.classList.add('clickable');
        eItem.title = 'Go to this position in the formula';
        eItem.addEventListener('click', () => jumpToFormula(oIssue.line, oIssue.column));
      }
      return eItem;
    }),
  );
}

// ---------- step 3: sign-in + environment ----------

const sAddProfileValue = '__add';

function profileLabel(oProfile) {
  const sName = oProfile.name && oProfile.name !== oProfile.username ? `${oProfile.name} (${oProfile.username})` : oProfile.username;
  return oProfile.needsReauth ? `${sName} — sign-in expired` : sName;
}

function renderProfiles(oSession) {
  const aProfiles = oSession.profiles ?? [];
  eProfileField.hidden = aProfiles.length === 0;
  eProfileSelect.disabled = oSession.state === 'pending';
  eProfileSelect.replaceChildren(
    ...aProfiles.map((oProfile) => new Option(profileLabel(oProfile), oProfile.id, false, oProfile.id === oSession.active?.id)),
    new Option('+ Add another account…', sAddProfileValue),
  );
}

function setConnection(sText, sClassName) {
  eConnectionPill.hidden = sText === '';
  eConnectionPill.textContent = sText;
  eConnectionPill.className = `badge ${sClassName}`;
}

function renderConnection() {
  const oSession = oState.oSession;
  const oActive = oSession?.state === 'signed-in' ? oSession.active : undefined;
  eReconnectButton.hidden = !oActive?.needsReauth;
  if (!oActive) setConnection('', '');
  else if (oActive.needsReauth) setConnection('Sign-in expired', 'warn');
  else if (oState.bEnvironmentsLoading) setConnection('Checking…', '');
  else if (oState.bEnvironmentsLoaded) setConnection('Connected', 'ok');
  else setConnection('', '');
}

function applySession(oSession) {
  const sPreviousProfile = oState.oSession?.state === 'signed-in' ? oState.oSession.active?.id : undefined;
  oState.oSession = oSession;
  window.clearTimeout(oState.iSessionTimer);
  const bPending = oSession.state === 'pending';
  const bSignedIn = oSession.state === 'signed-in';
  const oActive = oSession.active;

  renderProfiles(oSession);
  eSignInLink.hidden = !(bPending && typeof oSession.authorizeUrl === 'string' && oSession.authorizeUrl.startsWith(sSignInOrigin));
  if (!eSignInLink.hidden) eSignInLink.href = oSession.authorizeUrl;
  eLoginButton.hidden = bPending || (oSession.profiles ?? []).length > 0;
  eCancelLoginButton.hidden = !bPending;
  eRemoveProfileButton.hidden = !bSignedIn;
  eEnvSection.hidden = !bSignedIn;

  if (bPending) {
    setStatus(eAccountStatus, 'Waiting for you to finish signing in in your browser…', true);
    oState.iSessionTimer = window.setTimeout(refreshSession, 1500);
  } else if (oSession.error) {
    setStatus(eAccountStatus, `Sign-in failed: ${oSession.error}`);
  } else if (!bSignedIn) {
    setStatus(eAccountStatus, 'Sign in with your work account to list the environments you can deploy to.');
  } else {
    setStatus(eAccountStatus, '');
  }

  if (!bSignedIn || sPreviousProfile !== oActive?.id) {
    oState.aEnvironments = [];
    oState.bEnvironmentsLoaded = false;
    oState.sEnvironmentUrl = '';
    eEnvList.replaceChildren();
  }
  if (bSignedIn && oActive?.needsReauth) {
    setStatus(eEnvStatus, `The saved sign-in for ${oActive.username} has expired. Reconnect to load environments.`);
  } else if (bSignedIn && !oState.bEnvironmentsLoaded && !oState.bEnvironmentsLoading) {
    loadEnvironments();
  }
  renderConnection();
}

async function refreshSession() {
  try {
    applySession(await callApi('/api/studio/session'));
  } catch (oError) {
    setStatus(eAccountStatus, `Could not read the sign-in state: ${oError.message}`);
  }
}

async function sessionAction(sPath, oBody, sBusyText) {
  if (sBusyText) setStatus(eAccountStatus, sBusyText, true);
  try {
    applySession(await callApi(sPath, oBody));
  } catch (oError) {
    await refreshSession();
    setStatus(eAccountStatus, oError.message);
  }
}

function signIn(oOptions = {}) {
  return sessionAction('/api/studio/login', oOptions, 'Opening the sign-in page…');
}

function onProfileChange() {
  const sValue = eProfileSelect.value;
  if (sValue === sAddProfileValue) {
    renderProfiles(oState.oSession);
    signIn({ selectAccount: true });
    return;
  }
  sessionAction('/api/studio/profiles/select', { id: sValue }, 'Switching profile…');
}

async function removeProfile() {
  const oActive = oState.oSession?.active;
  if (!oActive || !window.confirm(`Forget the saved sign-in for ${oActive.username} on this computer?`)) return;
  await sessionAction('/api/studio/profiles/remove', { id: oActive.id }, '');
}

function environmentMatches(oEnvironment, sQuery) {
  return [oEnvironment.name, oEnvironment.url, oEnvironment.type].some((sValue) => sValue.toLowerCase().includes(sQuery));
}

function renderEnvironments() {
  if (oState.bEnvironmentsLoading) return;
  if (oState.aEnvironments.length === 0) {
    eEnvList.replaceChildren(oState.bEnvironmentsLoaded ? createElement('li', 'muted', 'No Dataverse environments found for this account.') : '');
    return;
  }
  const sQuery = eEnvSearch.value.trim().toLowerCase();
  const aVisible = oState.aEnvironments.filter((oEnvironment) => environmentMatches(oEnvironment, sQuery));
  setStatus(eEnvStatus, sQuery ? `Showing ${aVisible.length} of ${oState.aEnvironments.length} environments.` : `${oState.aEnvironments.length} environments.`);
  if (aVisible.length === 0) {
    eEnvList.replaceChildren(createElement('li', 'muted', 'No environments match the search.'));
    return;
  }
  eEnvList.replaceChildren(
    ...aVisible.map((oEnvironment) => {
      const bProduction = oEnvironment.type === 'Production' || oEnvironment.type === 'Default';
      const bSelected = oEnvironment.url === oState.sEnvironmentUrl;
      const eItem = createElement('li', `card clickable${bSelected ? ' selected' : ''}`);
      eItem.tabIndex = 0;
      eItem.setAttribute('role', 'option');
      eItem.setAttribute('aria-selected', String(bSelected));
      const eType = createElement('em', `badge ${bProduction ? 'warn' : ''}`, oEnvironment.type);
      eType.title = 'Environment type from Power Platform';
      eItem.append(createElement('strong', '', oEnvironment.name || oEnvironment.url), eType, createElement('span', 'muted url', oEnvironment.url));
      const selectEnvironment = () => {
        oState.sEnvironmentUrl = oEnvironment.url;
        renderEnvironments();
      };
      eItem.addEventListener('click', selectEnvironment);
      eItem.addEventListener('keydown', (oEvent) => {
        if (oEvent.key === 'Enter' || oEvent.key === ' ') {
          oEvent.preventDefault();
          selectEnvironment();
        }
      });
      return eItem;
    }),
  );
}

async function loadEnvironments() {
  oState.bEnvironmentsLoading = true;
  renderConnection();
  eEnvList.replaceChildren();
  setStatus(eEnvStatus, 'Loading environments…', true);
  try {
    const oResult = await callApi('/api/studio/environments');
    oState.aEnvironments = oResult.environments;
    oState.bEnvironmentsLoaded = !oResult.error;
    oState.bEnvironmentsLoading = false;
    renderEnvironments();
    if (oResult.error) setStatus(eEnvStatus, `Could not load environments: ${oResult.error}`);
    if (oResult.signInRequired) await refreshSession();
  } catch (oError) {
    oState.bEnvironmentsLoading = false;
    setStatus(eEnvStatus, `Could not load environments: ${oError.message}`);
  }
  renderConnection();
}

// ---------- step 4: deploy ----------

function selectedEnvironment() {
  return oState.aEnvironments.find((oEnvironment) => oEnvironment.url === oState.sEnvironmentUrl);
}

function renderDeploySummary() {
  const oSpec = readSpecFromForm();
  const oEnvironment = selectedEnvironment();
  const aRows = [
    ['Plug-in', `${oSpec.displayName} (${oSpec.uniqueName})`],
    ['Kind', oSpec.kind === 'automated' ? `Automated · ${oSpec.trigger.message} of ${oSpec.trigger.table} · ${oSpec.trigger.stage}` : `Instant · ${oSpec.parameters.length} parameter(s)`],
    ['Solution', `${oSpec.solution.uniqueName} (publisher ${oSpec.solution.publisher.uniqueName})`],
    ['Check', oState.oLastCheck ? (oState.oLastCheck.ok ? 'passed' : 'has errors') : 'not run'],
    ['Environment', oEnvironment ? `${oEnvironment.name} · ${oEnvironment.url}` : 'none selected'],
  ];
  eDeploySummary.replaceChildren(...aRows.flatMap(([sTerm, sValue]) => [createElement('dt', '', sTerm), createElement('dd', '', sValue)]));
  if (oState.bDeploying) return;
  const bReady = Boolean(oEnvironment) && oState.oLastCheck?.ok === true && oState.sLastCheckedText === specText();
  document.getElementById('btn-deploy').disabled = !bReady;
  if (!bReady) setStatus(eDeployStatus, 'Pass the check and select an environment first.');
  else if (eDeploySteps.childElementCount === 0) setStatus(eDeployStatus, '');
}

function askConfirmation(sMessage) {
  return new Promise((resolve) => {
    document.getElementById('confirm-text').textContent = sMessage;
    eConfirmDialog.addEventListener('close', () => resolve(eConfirmDialog.returnValue === 'confirm'), { once: true });
    eConfirmDialog.showModal();
  });
}

function renderDeploySteps(aSteps) {
  eDeploySteps.replaceChildren(
    ...aSteps.map((oStep) => {
      const eItem = createElement('li', oStep.status);
      const eTitle = createElement('strong', oStep.status === 'running' ? 'status busy' : '', `${oStep.step}: ${oStep.status}`);
      eItem.append(eTitle, createElement('pre', '', oStep.detail));
      return eItem;
    }),
  );
}

function showSolutionLink(sUrl) {
  const bValid = typeof sUrl === 'string' && sUrl.startsWith(sMakerPortalOrigin);
  eSolutionLink.hidden = !bValid;
  if (bValid) eSolutionLink.href = sUrl;
}

function finishDeploy(oJob) {
  window.clearTimeout(oState.iDeployTimer);
  oState.bDeploying = false;
  document.getElementById('btn-deploy').disabled = false;
  const oResult = oJob.result;
  if (!oResult) {
    setStatus(eDeployStatus, `Deploy failed: ${oJob.error ?? 'no result.'}`);
    return;
  }
  renderDeploySteps(oResult.steps);
  setStatus(eDeployStatus, `Deploy ${oResult.status} after ${formatElapsed(Date.now() - oState.iDeployStartedAt)}.`);
  showSolutionLink(oResult.solutionUrl);
}

async function pollDeploy() {
  try {
    const oJob = await callApi('/api/studio/deploy');
    renderDeploySteps(oJob.steps);
    if (!oJob.running) {
      finishDeploy(oJob);
      return;
    }
    const oRunning = oJob.steps.find((oStep) => oStep.status === 'running');
    setStatus(eDeployStatus, `Deploying… ${formatElapsed(Date.now() - oState.iDeployStartedAt)}${oRunning ? ` · ${oRunning.step}` : ''}`, true);
  } catch (oError) {
    setStatus(eDeployStatus, `Lost track of the deploy (${oError.message}); retrying…`, true);
  }
  oState.iDeployTimer = window.setTimeout(pollDeploy, 1000);
}

async function runDeploy() {
  const oEnvironment = selectedEnvironment();
  if (!oEnvironment) return;
  const bConfirmed = await askConfirmation(`${readSpecFromForm().displayName} → ${oEnvironment.name} (${oEnvironment.type}, ${oEnvironment.url})`);
  if (!bConfirmed) return;
  const eButton = document.getElementById('btn-deploy');
  eButton.disabled = true;
  oState.bDeploying = true;
  eDeploySteps.replaceChildren();
  showSolutionLink('');
  oState.iDeployStartedAt = Date.now();
  setStatus(eDeployStatus, 'Deploying… solution import can take a few minutes.', true);
  try {
    const oJob = await callApi('/api/studio/deploy', { spec: specText(), environmentUrl: oEnvironment.url, confirmEnvironmentUrl: oEnvironment.url });
    renderDeploySteps(oJob.steps);
    oState.iDeployTimer = window.setTimeout(pollDeploy, 1000);
  } catch (oError) {
    setStatus(eDeployStatus, `Deploy failed: ${oError.message}`);
    oState.bDeploying = false;
    eButton.disabled = false;
  }
}

// ---------- startup ----------

function bindEvents() {
  document.querySelectorAll('.step').forEach((eButton) => eButton.addEventListener('click', () => showStep(eButton.dataset.step)));
  document.querySelectorAll('[data-goto]').forEach((eButton) => eButton.addEventListener('click', () => showStep(eButton.dataset.goto)));
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-new-instant').addEventListener('click', () => newSpec('instant'));
  document.getElementById('btn-new-automated').addEventListener('click', () => newSpec('automated'));
  document.getElementById('btn-open').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', (oEvent) => openFile(oEvent.target));
  document.getElementById('example-select').addEventListener('change', (oEvent) => {
    if (oEvent.target.value) loadExample(oEvent.target.value);
    oEvent.target.value = '';
  });
  document.getElementById('btn-download').addEventListener('click', downloadSpec);
  document.getElementById('btn-toggle-json').addEventListener('click', () => {
    eJsonView.hidden = !eJsonView.hidden;
    eJsonView.textContent = specText();
  });
  document.getElementById('btn-add-param').addEventListener('click', () => {
    addParameterRow();
    onSpecChanged();
  });
  field('uniqueName').addEventListener('input', () => {
    oState.bUniqueNameTouched = field('uniqueName').value.trim() !== '';
  });
  ['displayName', 'publisherPrefix'].forEach((sName) => field(sName).addEventListener('input', suggestUniqueName));
  eForm.addEventListener('input', onSpecChanged);
  eForm.addEventListener('change', onSpecChanged);
  ['keyup', 'click'].forEach((sEvent) => eFormula.addEventListener(sEvent, updateCursorPosition));
  document.getElementById('btn-check').addEventListener('click', () => {
    oState.sLastCheckedText = '';
    runCheck();
  });
  document.getElementById('btn-refresh').addEventListener('click', loadEnvironments);
  eEnvSearch.addEventListener('input', renderEnvironments);
  eLoginButton.addEventListener('click', () => signIn());
  eReconnectButton.addEventListener('click', () => signIn({ reconnect: true }));
  eCancelLoginButton.addEventListener('click', () => sessionAction('/api/studio/login/cancel', {}, ''));
  eRemoveProfileButton.addEventListener('click', removeProfile);
  eProfileSelect.addEventListener('change', onProfileChange);
  document.getElementById('btn-deploy').addEventListener('click', runDeploy);
}

async function start() {
  applyTheme(localStorage.getItem(sThemeKey) ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  bindEvents();
  try {
    oState.oMeta = await callApi('/api/studio/meta');
    document.getElementById('tool-version').textContent = oState.oMeta.tool.version;
    fillSelect(field('triggerMessage'), oState.oMeta.messages);
    fillSelect(field('triggerStage'), oState.oMeta.stages);
    oState.oMeta.examples.forEach((sName) => document.getElementById('example-select').append(new Option(sName, sName)));
    await newSpec('instant');
  } catch (oError) {
    showLoadError(`Cannot reach the local server (${oError.message}). Reopen the session link printed in the terminal.`);
  }
}

start();
