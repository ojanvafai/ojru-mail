// Client ID and API key from the Developer Console
let CLIENT_ID = '749725088976-5n899es2a9o5p85epnamiqekvkesluo5.apps.googleusercontent.com';

// Array of API discovery doc URLs for APIs used by the quickstart
let DISCOVERY_DOCS = ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    "https://sheets.googleapis.com/$discovery/rest?version=v4",
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"];

// Authorization scopes required by the API; multiple scopes can be
// included, separated by spaces.
let SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets https://www.google.com/m8/feeds https://www.googleapis.com/auth/drive.metadata.readonly';

let USER_ID = 'me';

let QUEUED_LABELS_SHEET_NAME = 'queued_labels';

let authorizeButton = document.getElementById('authorize-button');

async function updateCounter(contents) {
  let counter = document.getElementById('counter');
  counter.textContent = '';
  counter.append(...contents);
}

// TODO: Make this private to this file.
let g_labels = {};
let currentView_;
let settings_;

// Make sure links open in new tabs.
document.body.addEventListener('click', (e) => {
  for (let node of e.path) {
    if (node.tagName == 'A') {
      node.target = '_blank';
      node.rel = 'noopener';
    }
  }
});

document.addEventListener('visibilitychange', (e) => {
  if (!currentView_)
    return;
  if (document.visibilityState == 'hidden')
    currentView_.onHide();
  else
    currentView_.onShow();
});


window.onload = () => {
  gapi.load('client:auth2', () => {
    gapi.client.init({
      discoveryDocs: DISCOVERY_DOCS,
      clientId: CLIENT_ID,
      scope: SCOPES
    }).then(function () {
      // Listen for sign-in state changes.
      gapi.auth2.getAuthInstance().isSignedIn.listen(updateSigninStatus);
      // Handle the initial sign-in state.
      updateSigninStatus(gapi.auth2.getAuthInstance().isSignedIn.get());
      authorizeButton.onclick = () => {
        gapi.auth2.getAuthInstance().signIn();
      };
    });
  });
};

window.addEventListener('error', (e) => {
  var emailBody = 'Captured an error: ' + JSON.stringify(e);
  if (e.body)
    emailBody += '\n' + e.body;
  if (e.stack)
    emailBody += '\n\n' + e.stack;

  // TODO: figure out how to send emails once this is back on a cron.
  alert('Error: ' + JSON.stringify(e));
});

window.addEventListener('unhandledrejection', (e) => {
  // 401 means the credentials are invalid and you probably need to 2 factor.
  if (e.reason && e.reason.status == 401)
    window.location.reload();
  else if (e.reason)
    alert(JSON.stringify(e.reason));
  else
    alert(JSON.stringify(e));
});

function showDialog(contents) {
  let dialog = document.createElement('dialog');
  dialog.style.cssText = `
    max-width: 85%;
    max-height: 85%;
    position: fixed;
    overflow: auto;
    top: 15px;
  `;
  dialog.addEventListener('close', () => dialog.remove());

  dialog.append(contents);
  document.body.append(dialog);

  dialog.showModal();
  return dialog;
}

function showSettings() {
  let view = new SettingsView(settings_);
}

async function fetchSheet(spreadsheetId, sheetName) {
  let response =  await gapiFetch(gapi.client.sheets.spreadsheets.values.get, {
    spreadsheetId: spreadsheetId,
    range: sheetName,
  });
  return response.result.values;
};

async function fetch2ColumnSheet(spreadsheetId, sheetName, opt_startRowIndex) {
  let result = {};
  let values = await fetchSheet(spreadsheetId, sheetName);
  if (!values)
    return result;

  let startRowIndex = opt_startRowIndex || 0;
  for (var i = startRowIndex; i < values.length; i++) {
    let value = values[i];
    result[value[0]] = value[1];
  }
  return result;
}

async function transitionBackToThreadAtATime(threadsToTriage, threadsToDone) {
  await viewThreadAtATime(threadsToTriage);

  for (let i = 0; i < threadsToDone.length; i++) {
    updateTitle('archiving', `Archiving ${i + 1}/${threadsToDone.length} threads...`);
    let thread = threadsToDone[i];
    await thread.markTriaged();
  }
  updateTitle('archiving');
}

async function viewThreadAtATime(threads) {
  let threadList = new ThreadList();
  for (let thread of threads) {
    await threadList.push(thread);
  }

  let blockedLabel = addQueuedPrefix(BLOCKED_LABEL_SUFFIX);
  let timeout = settings_.get(ServerStorage.KEYS.TIMER_DURATION);
  let allowedReplyLength =  settings_.get(ServerStorage.KEYS.ALLOWED_REPLY_LENGTH);
  let showSummary = !settings_.get(ServerStorage.KEYS.VACATION_SUBJECT);
  setView(new ThreadView(threadList, viewAll, updateCounter, blockedLabel, timeout, allowedReplyLength, contacts_, !showSummary));
}

async function viewAll(threads) {
  setView(new Vueue(threads, transitionBackToThreadAtATime));
  updateCounter(['']);
}

function setView(view) {
  currentView_ = view;
  var content = document.getElementById('content');
  content.textContent = '';
  content.append(view);
}

async function updateSigninStatus(isSignedIn) {
  if (isSignedIn) {
    authorizeButton.parentNode.style.display = 'none';
    await updateThreadList();
  } else {
    authorizeButton.parentNode.style.display = '';
  }
}

let titleStack_ = [];

async function updateTitle(key, opt_title, opt_needsLoader) {
  let index = titleStack_.findIndex((item) => item.key == key);
  if (!opt_title) {
    if (index != -1)
      titleStack_.splice(index, 1);
  } else if (index == -1) {
    titleStack_.push({
      key: key,
      title: opt_title,
      needsLoader: !!opt_needsLoader,
    });
  } else {
    let entry = titleStack_[index];
    entry.title = opt_title;
    entry.needsLoader = !!opt_needsLoader;
  }

  let title = titleStack_.length ? titleStack_[titleStack_.length - 1].title : '';
  document.getElementById('title').textContent = title;

  let needsLoader = titleStack_.findIndex((item) => item.needsLoader) != -1;
  showLoader(needsLoader);
}

function showLoader(show) {
  document.getElementById('loader').style.display = show ? 'inline-block' : 'none';
}

document.body.addEventListener('keydown', async (e) => {
  if (!currentView_)
    return;

  if (e.target.tagName == 'INPUT')
    return;

  // Don't allow actions to apply in rapid succession for each thread.
  // This prevents accidents of archiving a lot of threads at once
  // when your stupid keyboard gets stuck holding the archive key down. #sigh
  if (e.repeat)
    return;

  if (e.key == '?') {
    showHelp(settings_);
    return;
  }

  if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey)
    await currentView_.dispatchShortcut(e);
});

// TODO: make it so that labels created can have visibility of "hide" once we have a need for that.
async function createLabel(labelName) {
  let resp = await gapiFetch(gapi.client.gmail.users.labels.create, {
    userId: USER_ID,
    name: labelName,
    messageListVisibility: 'show',
    labelListVisibility: 'labelShow',
  });
  return resp.result;
}

async function getLabelId(labelName) {
  if (g_labels.labelToId[labelName])
    return g_labels.labelToId[labelName];

  await updateLabelList();
  var parts = labelName.split('/');

  // Create all the parent labels as well as the final label.
  var labelSoFar = '';
  for (var part of parts) {
    var prefix = labelSoFar ? '/' : '';
    labelSoFar += prefix + part;
    // creating a label 409's if the label already exists.
    // Technically we should handle the race if the label
    // gets created in between the start of the create call and this line. Meh.
    if (g_labels.labelToId[labelSoFar])
      continue;

    var result = await createLabel(labelSoFar);
    var id = result.id;
    g_labels.labelToId[labelSoFar] = id;
    g_labels.idToLabel[id] = labelSoFar;
  }

  return g_labels.labelToId[labelName];
}

async function fetchThreads(label, forEachThread, options) {
  let query = 'in:' + label;

  if (options && options.query)
    query += ' ' + options.query;

  let queue = options && options.queue;
  if (queue)
    query += ' in:' + options.queue;

  // We only have triaged labels once they've actually been created.
  if (g_labels.triagedLabels.length)
    query += ' -(in:' + g_labels.triagedLabels.join(' OR in:') + ')';

  let getPageOfThreads = async (opt_pageToken) => {
    let requestParams = {
      'userId': USER_ID,
      'q': query,
    };

    if (opt_pageToken)
      requestParams.pageToken = opt_pageToken;

    let resp = await gapiFetch(gapi.client.gmail.users.threads.list, requestParams);
    let threads = resp.result.threads || [];
    for (let rawThread of threads) {
      let thread = new Thread(rawThread);
      thread.setQueue(queue);
      await forEachThread(thread);
    }

    let nextPageToken = resp.result.nextPageToken;
    if (nextPageToken)
      await getPageOfThreads(nextPageToken);
  };

  await getPageOfThreads();
}

async function addThread(thread) {
  let vacationSubject = settings_.get(ServerStorage.KEYS.VACATION_SUBJECT);
  if (vacationSubject) {
    let subject = await thread.getSubject();
    if (!subject.toLowerCase().includes(vacationSubject.toLowerCase()))
      return;
  }
  await currentView_.push(thread);
}

async function updateThreadList() {
  showLoader(true);

  settings_ = new Settings();
  await Promise.all([settings_.fetch(), updateLabelList(), viewAll([])]);

  let storage = new ServerStorage(settings_.spreadsheetId);
  if (!storage.get(ServerStorage.KEYS.HAS_SHOWN_FIRST_RUN)) {
    await showHelp(settings_);
    storage.writeUpdates([{key: ServerStorage.KEYS.HAS_SHOWN_FIRST_RUN, value: true}]);
  }

  let settingsLink = document.getElementById('settings');
  settingsLink.textContent = 'Settings';
  settingsLink.onclick = showSettings;

  let helpLink = document.getElementById('help');
  helpLink.textContent = 'Help';
  helpLink.onclick = () => showHelp(settings_);

  let vacationQuery;
  if (settings_.get(ServerStorage.KEYS.VACATION_SUBJECT)) {
    vacationQuery = `subject:${settings_.get(ServerStorage.KEYS.VACATION_SUBJECT)}`;
    updateTitle('vacation', `Only showing threads with ${vacationQuery}`);
  }

  updateTitle('updateThreadList', 'Fetching threads to triage...', true);

  let labels = await getTheadCountForLabels(isLabelToTriage);
  let labelsToFetch = labels.filter(data => data.count).map(data => data.name);
  labelsToFetch.sort(LabelUtils.compareLabels);

  for (let label of labelsToFetch) {
    await fetchThreads('inbox', addThread, {
      query: vacationQuery,
      queue: label,
    });
  }

  updateTitle('updateThreadList');
  // Don't want to show the earlier title, but still want to indicate loading is happening.
  // since we're going to processMail still. It's a less jarring experience if the loading
  // spinner doesn't go away and then come back when conteacts are done being fetched.
  showLoader(true);

  // Wait until we've fetched all the threads before trying to process updates regularly.
  setInterval(update, 1000 * 60);

  await fetchContacts(gapi.auth.getToken());
  await processMail();
}

let contacts_ = [];

async function fetchContacts(token) {
  // This is 450kb! Either cache this and fetch infrequently, or find a way of getting the API to not send me all
  // the data I don't want.
  let resp = await fetch("https://www.google.com/m8/feeds/contacts/default/thin?alt=json&access_token=" + token.access_token + "&max-results=20000&v=3.0")
  let json = await resp.json();
  for (let entry of json.feed.entry) {
    if (!entry.gd$email)
      continue;
    let contact = {};
    if (entry.title.$t)
      contact.name = entry.title.$t;
    contact.emails = [];
    for (let email of entry.gd$email) {
      contact.emails.push(email.address);
    }
    contacts_.push(contact);
  }
}

var isProcessingMail = false;

// TODO: Move this to a cron
async function processMail() {
  if (isProcessingMail)
    return;

  isProcessingMail = true;
  updateTitle('processMail', 'Processing mail backlog...', true);

  let queuedLabelMap = await fetch2ColumnSheet(settings_.spreadsheetId, QUEUED_LABELS_SHEET_NAME, 1);

  let mailProcessor = new MailProcessor(settings_, addThread, queuedLabelMap);
  await mailProcessor.processMail();
  await mailProcessor.processQueues();
  await mailProcessor.collapseStats();

  updateTitle('processMail');
  isProcessingMail = false;
}

function update() {
  currentView_.updateCurrentThread();
  processMail();
}

window.addEventListener('offline', (e) => {
  updateTitle('offline', 'No network connection...');
});

window.addEventListener('online', (e) => {
  updateTitle('offline');
  update();
});

async function updateLabelList() {
  var response = await gapiFetch(gapi.client.gmail.users.labels.list, {
    'userId': USER_ID
  })

  g_labels.labelToId = {};
  g_labels.idToLabel = {};
  g_labels.triagedLabels = [];
  for (let label of response.result.labels) {
    g_labels.labelToId[label.name] = label.id;
    g_labels.idToLabel[label.id] = label.name;
    if (label.name.startsWith(TRIAGED_LABEL + '/'))
      g_labels.triagedLabels.push(label.name);
  }
}

function isLabelToTriage(labelId, labelName) {
  let metaLabels = [TRIAGED_LABEL, LABELER_PREFIX, UNPROCESSED_LABEL];

  if (metaLabels.includes(labelName) ||
      labelName.startsWith(TRIAGED_LABEL + '/') ||
      labelName.startsWith(LABELER_PREFIX + '/'))
    return false;

  let isUserLabel = labelId.startsWith('Label_');
  return isUserLabel;
}

async function getTheadCountForLabels(labelFilter) {
  let batch = gapi.client.newBatch();

  for (let id in g_labels.idToLabel) {
    if (labelFilter(id, g_labels.idToLabel[id])) {
      batch.add(gapi.client.gmail.users.labels.get({
        userId: USER_ID,
        id: id,
      }));
    }
  }

  let labelsWithThreads = [];
  let labelDetails = await batch;
  for (let key in labelDetails.result) {
    let details = labelDetails.result[key].result;
    labelsWithThreads.push({
      name: details.name,
      count: details.threadsTotal,
    });
  }
  return labelsWithThreads;
}
