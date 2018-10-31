import { ComposeView } from './views/ComposeView.js';
import { ErrorDialog } from './ErrorDialog.js';
import { gapiFetch } from './Net.js';
import { IDBKeyVal } from './idb-keyval.js';
import { Labels } from './Labels.js';
import { MailProcessor } from './MailProcessor.js';
import { MakeTimeView } from './views/MakeTimeView.js';
import { Router } from './Router.js';
import { QueueSettings } from './QueueSettings.js';
import { ServerStorage } from './ServerStorage.js';
import { Settings } from './Settings.js';
import { SettingsView } from './views/Settings.js';
import { showHelp } from './help.js';
import { ThreadCache } from './ThreadCache.js';
import { ThreadGroups } from './ThreadGroups.js';
import { TriageView } from './views/TriageView.js';

// Client ID and API key from the Developer Console
let CLIENT_ID = location.toString().includes('appspot') ? '410602498749-pe1lolovqrgun0ia1jipke33ojpcmbpq.apps.googleusercontent.com' : '749725088976-5n899es2a9o5p85epnamiqekvkesluo5.apps.googleusercontent.com';

// Array of API discovery doc URLs for APIs used by the quickstart
let DISCOVERY_DOCS = ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
    "https://sheets.googleapis.com/$discovery/rest?version=v4",
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"];

// Authorization scopes required by the API; multiple scopes can be
// included, separated by spaces.
let SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets https://www.google.com/m8/feeds https://www.googleapis.com/auth/drive.metadata.readonly';

export let USER_ID = 'me';
let authorizeButton = document.getElementById('authorize-button');

let currentView_;
let settings_;
let labels_;
let queuedLabelMap_;
let threadCache_ = new ThreadCache();
let contacts_ = [];
let titleStack_ = [];
let loaderTitleStack_ = [];
let isProcessingMail_ = false;
let threads_ = new ThreadGroups();
let WEEKS_TO_STORE_ = 2;

var router = new Router();
router.add('/compose', async (foo) => {
  if (currentView_) {
    await currentView_.tearDown();
  }
  await viewCompose();
});
router.add('/', routeToTriage);
router.add('/triage', routeToTriage);
router.add('/make-time', async (foo) => {
  if (currentView_)
    await currentView_.tearDown();
  await viewMakeTime();
});
router.add('/best-effort', async (foo) => {
  if (currentView_)
    await currentView_.tearDown();

  threads_.processBestEffort();
  await viewTriage();
});

async function routeToTriage() {
  if (currentView_) {
    await currentView_.tearDown();
  }
  await viewTriage();
}

let DRAWER_OPEN = 'drawer-open';

function openMenu() {
  let mainContent = document.getElementById('main-content');
  mainContent.classList.add(DRAWER_OPEN);
}

function closeMenu() {
  let mainContent = document.getElementById('main-content');
  mainContent.classList.remove(DRAWER_OPEN);
}

function toggleMenu() {
  let mainContent = document.getElementById('main-content');
  if (mainContent.classList.contains(DRAWER_OPEN))
    closeMenu();
  else
    openMenu();
}

document.getElementById('hambuger-menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

document.getElementById('main-content').addEventListener('click', (e) => {
  let mainContent = document.getElementById('main-content');
  if (mainContent.classList.contains(DRAWER_OPEN)) {
    e.preventDefault();
    closeMenu();
  }
})

export function showDialog(contents) {
  let dialog = document.createElement('dialog');
  // Subtract out the top/bottom, padding and border from the max-height.
  dialog.style.cssText = `
    top: 15px;
    padding: 8px;
    border: 3px solid grey;
    max-height: calc(100vh - 30px - 16px - 6px);
    max-width: 800px;
    position: fixed;
    display: flex;
    overscroll-behavior: none;
  `;
  dialog.addEventListener('close', () => dialog.remove());

  dialog.append(contents);
  document.body.append(dialog);

  dialog.showModal();
  return dialog;
}

async function viewCompose() {
  setView(new ComposeView(contacts_));
}

async function viewTriage() {
  let autoStartTimer = settings_.get(ServerStorage.KEYS.AUTO_START_TIMER);
  let timerDuration = settings_.get(ServerStorage.KEYS.TIMER_DURATION);
  let allowedReplyLength =  settings_.get(ServerStorage.KEYS.ALLOWED_REPLY_LENGTH);
  let vacation = settings_.get(ServerStorage.KEYS.VACATION_SUBJECT);
  setView(new TriageView(threads_, labels_, vacation, await getQueuedLabelMap(), updateLoaderTitle, setSubject, allowedReplyLength, contacts_, autoStartTimer, timerDuration));
}

async function viewMakeTime() {
  // Don't show triaged queues view when in vacation mode as that's non-vacation work.
  let vacation = settings_.get(ServerStorage.KEYS.VACATION_SUBJECT);
  let autoStartTimer = settings_.get(ServerStorage.KEYS.AUTO_START_TIMER);
  let timerDuration = settings_.get(ServerStorage.KEYS.TIMER_DURATION);
  let allowedReplyLength =  settings_.get(ServerStorage.KEYS.ALLOWED_REPLY_LENGTH);
  setView(new MakeTimeView(threads_, labels_, vacation, updateLoaderTitle, setSubject, allowedReplyLength, contacts_, autoStartTimer, timerDuration));
}

function setView(view) {
  threads_.setListener(view);
  currentView_ = view;

  var content = document.getElementById('content');
  content.textContent = '';
  content.append(view);
}

async function updateSigninStatus(isSignedIn) {
  if (!isSignedIn) {
    authorizeButton.parentNode.style.display = '';
    return;
  }
  authorizeButton.parentNode.style.display = 'none';
  await onLoad();
}

function setSubject(...items) {
  let subject = document.getElementById('subject');
  subject.textContent = '';
  subject.append(...items);
}

function updateTitle(key, opt_title) {
  let node = document.getElementById('title');
  updateTitleBase(titleStack_, node, key, opt_title);
}

function updateLoaderTitle(key, opt_title) {
  let node = document.getElementById('loader-title');
  updateTitleBase(loaderTitleStack_, node, key, opt_title);

  let titleContainer = document.getElementById('loader');
  titleContainer.style.display = loaderTitleStack_.length ? '' : 'none';
}

function updateTitleBase(stack, node, key, ...opt_title) {
  let index = stack.findIndex((item) => item.key == key);
  if (!opt_title[0]) {
    if (index != -1)
      stack.splice(index, 1);
  } else if (index == -1) {
    stack.push({
      key: key,
      title: opt_title,
    });
  } else {
    let entry = stack[index];
    entry.title = opt_title;
  }

  node.textContent = '';
  if (stack.length)
    node.append(...stack[stack.length - 1].title);
}

export async function fetchThread(id) {
  let requestParams = {
    'userId': USER_ID,
    'id': id,
  };
  let resp = await gapiFetch(gapi.client.gmail.users.threads.get, requestParams);
  return threadCache_.get(resp.result, labels_);
}

export async function fetchThreads(forEachThread, options) {
  // Chats don't expose their bodies in the gmail API, so just skip them.
  let query = '-in:chats ';

  if (options.query)
    query += ' ' + options.query;

  if (options.queue)
    query += ' in:' + options.queue;


  let daysToShow = settings_.get(ServerStorage.KEYS.DAYS_TO_SHOW);
  if (daysToShow)
    query += ` newer_than:${daysToShow}d`;


  // We only have triaged labels once they've actually been created.
  if (!options.includeTriaged && labels_.getTriagedLabelNames().length)
    query += ' -(in:' + labels_.getTriagedLabelNames().join(' OR in:') + ')';

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
      let thread = threadCache_.get(rawThread, labels_);
      if (options.queue)
        thread.setQueue(options.queue);
      await forEachThread(thread);
    }

    let nextPageToken = resp.result.nextPageToken;
    if (nextPageToken)
      await getPageOfThreads(nextPageToken);
  };

  await getPageOfThreads();
}

async function isBestEffortQueue(thread) {
  let queue = await thread.getQueue();
  let parts = queue.split('/');
  let lastPart = parts[parts.length - 1];
  let data = (await getQueuedLabelMap()).get(lastPart);
  return data && data.goal == 'Best Effort';
}

// This function is all gross and hardcoded. Also, the constants themselves
// aren't great. Would be best to know how long the email was actually in the
// inbox rather than when the last email was sent, e.g. if someone was on vacation.
// Could track the last N dequeue dates for each queue maybe?
async function isBankrupt(thread) {
  let messages = await thread.getMessages();
  let date = messages[messages.length - 1].date;
  let queue = await thread.getQueue();
  let queueData = (await getQueuedLabelMap()).get(queue);

  let numDays = 7;
  if (queueData.queue == MailProcessor.WEEKLY)
    numDays = 14;
  else if (queueData.queue == MailProcessor.MONTHLY)
    numDays = 42;

  let oneDay = 24 * 60 * 60 * 1000;
  let diffDays = (Date.now() - date.getTime()) / (oneDay);
  return diffDays > numDays;
}

async function bankruptThread(thread) {
  let queue = await thread.getQueue();
  queue = Labels.removeNeedsTriagePrefix(queue);
  let newLabel = Labels.addBankruptPrefix(queue);
  await thread.markTriaged(newLabel);
}

// TODO: Don't export this.
export async function addThread(thread) {
  let vacationSubject = settings_.get(ServerStorage.KEYS.VACATION_SUBJECT);
  if (vacationSubject) {
    let subject = await thread.getSubject();
    if (!subject || !subject.toLowerCase().includes(vacationSubject.toLowerCase()))
      return;
  }

  if (threads_.getBestEffort() && await isBestEffortQueue(thread)) {
    if (await isBankrupt(thread)) {
      await bankruptThread(thread);
      return;
    } else if (threads_.getBestEffort()) {
      // Check again that getBestEffort is non-null in case best effort threads started being
      // triaged in the async time from the threads_.getBestEffort() call above.
      threads_.pushBestEffort(thread);
      return;
    }
  }

  if (currentView_ instanceof TriageView)
    await currentView_.addThread(thread);
}

function createMenuItem(name, options) {
  let a = document.createElement('a');
  a.append(name);
  a.className = 'item';

  if (options.nested)
    a.classList.add('nested');

  if (options.href)
    a.href = options.href;

  if (options.onclick)
    a.onclick = options.onclick;

  a.addEventListener('click', closeMenu);

  return a;
}

async function markTriaged(thread) {
  await thread.markTriaged(null);
}

// Archive threads that are needstriage, but not in the inbox or unprocessed.
async function cleanupNeedsTriageThreads() {
  let needsTriageLabels = labels_.getNeedsTriageLabelNames();
  // For new users, they won't have any needstriage labels.
  if (!needsTriageLabels.length)
    return;
  await fetchThreads(markTriaged, {
    query: `-in:inbox -in:${Labels.UNPROCESSED_LABEL} (in:${needsTriageLabels.join(' OR in:')})`,
  });
}

async function onLoad() {
  settings_ = new Settings();
  labels_ = new Labels();

  // TODO: Don't block on this if we're just going into compose view.
  await Promise.all([settings_.fetch(), labels_.fetch()]);

  let storage = new ServerStorage(settings_.spreadsheetId);
  if (!storage.get(ServerStorage.KEYS.HAS_SHOWN_FIRST_RUN)) {
    await showHelp(settings_);
    storage.writeUpdates([{key: ServerStorage.KEYS.HAS_SHOWN_FIRST_RUN, value: true}]);
  }

  let settingsButton = createMenuItem('Settings', {
    onclick: async () => new SettingsView(settings_, await getQueuedLabelMap()),
  });

  let helpButton = createMenuItem('Help', {
    onclick: () => showHelp(settings_),
  });

  let menuTitle = document.createElement('div');
  menuTitle.append('MakeTime phases');

  document.getElementById('drawer').append(
    menuTitle,
    createMenuItem('Compose', {href: '/compose', nested: true}),
    createMenuItem('Triage', {href: '/triage', nested: true}),
    createMenuItem('MakeTime', {href: '/make-time', nested: true}),
    settingsButton,
    helpButton);

  updateLoaderTitle('onLoad', 'Fetching threads to triage...');

  await router.run(window.location.pathname);

  // Don't want to show the earlier title, but still want to indicate loading is happening.
  // since we're going to processMail still. It's a less jarring experience if the loading
  // spinner doesn't go away and then come back when conteacts are done being fetched.
  updateLoaderTitle('onLoad', '\xa0');

  await fetchContacts(gapi.auth.getToken());

  update();
  // Wait until we've fetched all the threads before trying to process updates regularly.
  setInterval(update, 1000 * 60);

  updateLoaderTitle('onLoad');
}

let CONTACT_STORAGE_KEY_ = 'contacts';

async function fetchContacts(token) {
  if (contacts_.length)
    return;

  // This is 450kb! Either cache this and fetch infrequently, or find a way of getting the API to not send
  // the data we don't need.
  let response;
  try {
    response = await fetch("https://www.google.com/m8/feeds/contacts/default/thin?alt=json&access_token=" + token.access_token + "&max-results=20000&v=3.0");
  } catch(e) {
    let message = `Failed to fetch contacts. Google Contacts API is hella unsupported. See https://issuetracker.google.com/issues/115701813.`;

    let contacts = localStorage.getItem(CONTACT_STORAGE_KEY_);
    if (!contacts) {
      console.error(message);
      return;
    }

    console.error(`Using locally stored version of contacts. ${message}`);
    contacts_ = JSON.parse(contacts);
    return;
  }

  let json = await response.json();
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

  // Store the final contacts object instead of the data fetched off the network since the latter
  // can is order of magnitude larger and can exceed the allowed localStorage quota.
  localStorage.setItem(CONTACT_STORAGE_KEY_, JSON.stringify(contacts_));
}

async function getQueuedLabelMap() {
  if (!queuedLabelMap_) {
    queuedLabelMap_ = new QueueSettings(settings_.spreadsheetId);
    await queuedLabelMap_.fetch();
  }
  return queuedLabelMap_;
}

// TODO: Move this to a cron
async function processMail() {
  if (isProcessingMail_)
    return;

  isProcessingMail_ = true;
  updateLoaderTitle('processMail', 'Processing mail backlog...');

  let mailProcessor = new MailProcessor(settings_, addThread, await getQueuedLabelMap(), labels_, updateLoaderTitle);
  await mailProcessor.processMail();
  await mailProcessor.processQueues();
  await mailProcessor.collapseStats();

  updateLoaderTitle('processMail');
  isProcessingMail_ = false;
}

// TODO: Put this somewhere better.
export function getCurrentWeekNumber() {
  let today = new Date();
  var januaryFirst = new Date(today.getFullYear(), 0, 1);
  var msInDay = 86400000;
  return Math.ceil((((today - januaryFirst) / msInDay) + januaryFirst.getDay()) / 7);
}

async function gcLocalStorage() {
  let storage = new ServerStorage(settings_.spreadsheetId);
  let lastGCTime = storage.get(ServerStorage.KEYS.LAST_GC_TIME);
  let oneDay = 24 * 60 * 60 * 1000;
  if (!lastGCTime || Date.now() - lastGCTime > oneDay) {
    let currentWeekNumber = getCurrentWeekNumber();
    let keys = await IDBKeyVal.getDefault().keys();
    for (let key of keys) {
      let match = key.match(/^thread-(\d+)-\d+$/);
      if (!match)
        continue;

      let weekNumber = Number(match[1]);
      if (weekNumber + WEEKS_TO_STORE_ < currentWeekNumber)
        await IDBKeyVal.getDefault().del(key);
    }
    await storage.writeUpdates([{key: ServerStorage.KEYS.LAST_GC_TIME, value: Date.now()}]);
  }
}

async function update() {
  await cleanupNeedsTriageThreads();
  if (currentView_.updateCurrentThread)
    await currentView_.updateCurrentThread();
  await processMail();
  await gcLocalStorage();
}

// Make sure links open in new tabs.
document.body.addEventListener('click', async (e) => {
  for (let node of e.path) {
    if (node.tagName == 'A') {
      if (await router.run(node)) {
        e.preventDefault();
        return;
      }
      node.target = '_blank';
      node.rel = 'noopener';
    }
  }
});

// This list is probably not comprehensive.
let NON_TEXT_INPUT_TYPES = [
  'button',
  'checkbox',
  'file',
  'image',
  'radio',
  'submit',
];

function isEditable(target) {
  if (target.tagName == 'INPUT' && !NON_TEXT_INPUT_TYPES.includes(target.type))
    return true;

  if (target.tagName == 'TEXTAREA')
    return true;

  while (target) {
    if (getComputedStyle(target).webkitUserModify.startsWith('read-write'))
      return true;
    target = target.parentElement;
  }

  return false;
}

document.body.addEventListener('keydown', async (e) => {
  if (!currentView_)
    return;

  if (isEditable(e.target))
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

  if (currentView_.dispatchShortcut && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey)
    await currentView_.dispatchShortcut(e);
});

window.addEventListener('load', () => {
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
      authorizeButton.onclick = () => gapi.auth2.getAuthInstance().signIn();
    });
  });
});

window.addEventListener('error', (e) => {
  var emailBody = 'Something went wrong...';
  if (e.body)
    emailBody += '\n' + e.body;
  if (e.error)
    emailBody += '\n' + e.error;
  if (e.stack)
    emailBody += '\n\n' + e.stack;
  new ErrorDialog(emailBody);
});

window.addEventListener('unhandledrejection', (e) => {
  // 401 means the credentials are invalid and you probably need to 2 factor.
  if (e.reason && e.reason.status == 401)
    window.location.reload();
  new ErrorDialog(e.reason);
});

window.addEventListener('offline', (e) => {
  updateTitle('offline', 'No network connection...');
});

window.addEventListener('online', (e) => {
  updateTitle('offline');
  update();
});
