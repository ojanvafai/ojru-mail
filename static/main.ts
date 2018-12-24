import { ErrorLogger } from './ErrorLogger.js';
import { Router } from './Router.js';
import { IDBKeyVal } from './idb-keyval.js';
// TODO: Clean up these dependencies to be less spaghetti.
import { updateLoaderTitle, updateTitle, setView, getView, getSettings,
         getQueuedLabelMap, getLabels, showHelp } from './BaseMain.js';
import { getCurrentWeekNumber } from './Base.js';
import { ServerStorage } from './ServerStorage.js';
import { ComposeView } from './views/ComposeView.js';
import { SettingsView } from './views/Settings.js';
import { ComposeModel } from './models/ComposeModel.js';
import { TriageModel } from './models/TriageModel.js';
import { TodoModel } from './models/TodoModel.js';
import { ThreadListView } from './views/ThreadListView.js';
import { ThreadListModel } from './models/ThreadListModel.js';

let contacts_: Contact[] = [];
let WEEKS_TO_STORE_ = 2;

var router = new Router();

async function routeToCurrentLocation() {
  await router.run(window.location, true);
}

window.onpopstate = () => {
  routeToCurrentLocation();
}

router.add('/compose', async (params) => {
  if (getView())
    getView().tearDown();
  await viewCompose(params);
});
router.add('/', routeToTriage);
router.add('/triage', routeToTriage);
router.add('/todo', async (_params) => {
  if (getView())
    getView().tearDown();
  await viewTodo();
});
// TODO: best-effort should not be a URL since it's not a proper view.
// or should it be a view instead?
router.add('/best-effort', async (_params) => {
  (await getTriageModel()).triageBestEffort();
  await router.run('/triage');
});

async function routeToTriage() {
  if (getView())
    getView().tearDown();
  await viewTriage();
}

let DRAWER_OPEN = 'drawer-open';
let CURRENT_PAGE_CLASS = 'current-page';

function showBackArrow(show: boolean) {
  (<HTMLElement> document.getElementById('hambuger-menu-toggle')).style.display = show ? 'none' : '';
  (<HTMLElement> document.getElementById('back-arrow')).style.display = show ? '' : 'none';
}

function openMenu() {
  let drawer = <HTMLElement> document.getElementById('drawer');
  let menuItems = <NodeListOf<HTMLAnchorElement>> drawer.querySelectorAll('a.item');
  for (let item of menuItems) {
    if (item.pathname == location.pathname) {
      item.classList.add(CURRENT_PAGE_CLASS);
    } else {
      item.classList.remove(CURRENT_PAGE_CLASS);
    }
  }

  let mainContent = <HTMLElement> document.getElementById('main-content');
  mainContent.classList.add(DRAWER_OPEN);
}

function closeMenu() {
  let mainContent = <HTMLElement> document.getElementById('main-content');
  mainContent.classList.remove(DRAWER_OPEN);
}

function toggleMenu() {
  let mainContent = <HTMLElement> document.getElementById('main-content');
  if (mainContent.classList.contains(DRAWER_OPEN))
    closeMenu();
  else
    openMenu();
}

(<HTMLElement> document.getElementById('back-arrow')).addEventListener('click', async () => {
  if (getView().goBack)
    await getView().goBack();
});

(<HTMLElement> document.getElementById('hambuger-menu-toggle')).addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

(<HTMLElement> document.getElementById('main-content')).addEventListener('click', (e) => {
  let mainContent = <HTMLElement> document.getElementById('main-content');
  if (mainContent.classList.contains(DRAWER_OPEN)) {
    e.preventDefault();
    closeMenu();
  }
})

async function viewCompose(params: any) {
  let model = new ComposeModel(updateLoaderTitle);
  await setView(new ComposeView(model, contacts_, params));
}

async function createThreadListView(model: ThreadListModel, countDown: boolean, bottomButtonUrl: string, bottomButtonText: string) {
  let settings = await getSettings();
  let autoStartTimer = settings.get(ServerStorage.KEYS.AUTO_START_TIMER);
  let timerDuration = settings.get(ServerStorage.KEYS.TIMER_DURATION);
  let allowedReplyLength =  settings.get(ServerStorage.KEYS.ALLOWED_REPLY_LENGTH);

  return new ThreadListView(model, await getLabels(), getScroller(),
    updateLoaderTitle, setSubject, showBackArrow, allowedReplyLength, contacts_, autoStartTimer,
    countDown, timerDuration, bottomButtonUrl, bottomButtonText);
}

async function viewTriage() {
  updateLoaderTitle('viewTriage', 'Fetching threads to triage...');

  let countDown = true;
  let view = await createThreadListView(await getTriageModel(), countDown, '/todo', 'Go to todo list');
  await setView(view);

  updateLoaderTitle('viewTriage', '');
}

let triageModel_: TriageModel;
async function getTriageModel() {
  if (!triageModel_) {
    let settings = await getSettings();
    let vacation = settings.get(ServerStorage.KEYS.VACATION);
    triageModel_ = new TriageModel(updateLoaderTitle, vacation, await getLabels(), settings, await getQueuedLabelMap());
  }
  return triageModel_;
}

let todoModel_: TodoModel;
async function getTodoModel() {
  if (!todoModel_) {
    let settings = await getSettings();
    let vacation = settings.get(ServerStorage.KEYS.VACATION);
    todoModel_ = new TodoModel(updateLoaderTitle, vacation, await getLabels());
  }
  return todoModel_;
}

async function viewTodo() {
  let countDown = true;
  let view = await createThreadListView(await getTodoModel(), countDown, '/triage', 'Back to Triaging');
  await setView(view);
}

function getScroller() {
  return <HTMLElement> document.getElementById('content');
}

function setSubject(...items: (string | Node)[]) {
  let subject = <HTMLElement> document.getElementById('subject');
  subject.textContent = '';
  subject.append(...items);
}

function createMenuItem(name: string, options: any) {
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

async function onLoad() {
  let settingsButton = createMenuItem('Settings', {
    onclick: async () => {
      new SettingsView(await getSettings(), await getQueuedLabelMap());
    }
  });

  let helpButton = createMenuItem('Help', {
    onclick: async () => showHelp(),
  });

  let menuTitle = document.createElement('div');
  menuTitle.append('MakeTime phases');

  (<HTMLElement>document.getElementById('drawer')).append(
    menuTitle,
    createMenuItem('Compose', {href: '/compose', nested: true}),
    createMenuItem('Triage', {href: '/triage', nested: true}),
    createMenuItem('Todo', {href: '/todo', nested: true}),
    settingsButton,
    helpButton);

  await routeToCurrentLocation();

  // Don't want to show the earlier title, but still want to indicate loading is happening.
  // since we're going to processMail still. It's a less jarring experience if the loading
  // spinner doesn't go away and then come back when conteacts are done being fetched.
  updateLoaderTitle('onLoad', '\xa0');

  // @ts-ignore TODO: Figure out how to get types for gapi client libraries.
  await fetchContacts(gapi.auth.getToken());

  await update();
  // Wait until we've fetched all the threads before trying to process updates regularly.
  setInterval(update, 1000 * 60);

  updateLoaderTitle('onLoad');
}

onLoad();

let CONTACT_STORAGE_KEY_ = 'contacts';

interface Contact {
  name: string;
  emails: string[];
}

async function fetchContacts(token: any) {
  if (contacts_.length)
    return;

  // This is 450kb! Either cache this and fetch infrequently, or find a way of getting the API to not send
  // the data we don't need.
  let response;
  try {
    response = await fetch("https://www.google.com/m8/feeds/contacts/default/thin?alt=json&access_token=" + token.access_token + "&max-results=20000&v=3.0");
  } catch(e) {
    let message = `Failed to fetch contacts. Google Contacts API is hella unsupported. See https://issuetracker.google.com/issues/115701813.`;

    let contacts = await IDBKeyVal.getDefault().get(CONTACT_STORAGE_KEY_);
    if (!contacts) {
      ErrorLogger.log(message);
      return;
    }

    ErrorLogger.log(`Using locally stored version of contacts. ${message}`);

    // Manually copy each contact instead of just assigning because contacts_ is passed
    // around and stored.
    let parsed = JSON.parse(contacts);
    for (let contact of parsed) {
      contacts_.push(contact);
    }
    return;
  }

  let json = await response.json();
  for (let entry of json.feed.entry) {
    if (!entry.gd$email)
      continue;
    let contact = <Contact> {};
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
  await IDBKeyVal.getDefault().set(CONTACT_STORAGE_KEY_, JSON.stringify(contacts_));
}

async function gcLocalStorage() {
  let storage = new ServerStorage((await getSettings()).spreadsheetId);
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

let isUpdating_ = false;

export async function update() {
  if (isUpdating_)
    return;
  isUpdating_ = true;

  // Do the todo model first since it doens't need to send anything through
  // MailProcessor, so is relatively constant time.
  let todoModel = await getTodoModel();
  await todoModel.update();

  let triageModel = await getTriageModel();
  await triageModel.update();

  await(await getView()).update();

  await gcLocalStorage();

  isUpdating_ = false;
}

// Make sure links open in new tabs.
document.body.addEventListener('click', async (e) => {
  for (let node of e.path) {
    if (node.tagName == 'A') {
      let anchor = <HTMLAnchorElement> node;
      let willHandlePromise = router.run(anchor);
      if (willHandlePromise) {
        // Need to preventDefault before the await, otherwise the browsers
        // default action kicks in.
        e.preventDefault();
        await willHandlePromise;
        return;
      }
      anchor.target = '_blank';
      anchor.rel = 'noopener';
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

function isEditable(element: Element) {
  if (element.tagName == 'INPUT' && !NON_TEXT_INPUT_TYPES.includes((<HTMLInputElement>element).type))
    return true;

  if (element.tagName == 'TEXTAREA')
    return true;

  let parent: Element | null = element;
  while (parent) {
    let userModify = getComputedStyle(parent).webkitUserModify;
    if (userModify && userModify.startsWith('read-write'))
      return true;
    parent = parent.parentElement;
  }

  return false;
}

document.addEventListener("visibilitychange", function() {
  if (document.visibilityState == 'visible')
    update();
});

document.body.addEventListener('keydown', async (e) => {
  if (!getView())
    return;

  if (isEditable(<Element>e.target))
    return;

  if (e.key == '?') {
    showHelp();
    return;
  }

  if (getView().dispatchShortcut && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey)
    await getView().dispatchShortcut(e);
});

window.addEventListener('error', (e) => {
  var emailBody = 'Something went wrong...';
  if (e.body)
    emailBody += '\n' + e.body;
  if (e.error)
    emailBody += '\n' + e.error;
  if (e.stack)
    emailBody += '\n\n' + e.stack;
  ErrorLogger.log(emailBody);
});

window.addEventListener('unhandledrejection', (e) => {
  // 401 means the credentials are invalid and you probably need to 2 factor.
  if (e.reason && e.reason.status == 401)
    window.location.reload();
  ErrorLogger.log(e.reason);
});

window.addEventListener('offline', () => {
  updateTitle('offline', 'No network connection...');
});

window.addEventListener('online', () => {
  updateTitle('offline');
  update();
});
