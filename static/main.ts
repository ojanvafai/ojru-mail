import {defined, getCurrentWeekNumber, isMobileUserAgent, showDialog} from './Base.js';
import {firestore, getServerStorage, getSettings} from './BaseMain.js';
import {Calendar} from './calendar/Calendar.js';
import {Contacts} from './Contacts.js';
import {ErrorLogger} from './ErrorLogger.js';
import {IDBKeyVal} from './idb-keyval.js';
import {LongTasks} from './LongTasks.js';
import {MailProcessor} from './MailProcessor.js';
import {ComposeModel} from './models/ComposeModel.js';
import {Model} from './models/Model.js';
import {TodoModel} from './models/TodoModel.js';
import {TrackingModel} from './models/TrackingModel.js';
import {TriageModel} from './models/TriageModel.js';
import {CONNECTION_FAILURE_KEY} from './Net.js';
import {Router} from './Router.js';
import {SendAs} from './SendAs.js';
import {ServerStorage, ServerStorageUpdateEventName} from './ServerStorage.js';
import {Themes} from './Themes.js';
import {AppShell, BackEvent, OverflowMenuOpenEvent, ToggleViewEvent} from './views/AppShell.js';
import {CalendarView} from './views/CalendarView.js';
import {ComposeView} from './views/ComposeView.js';
import {ViewFiltersChanged as ViewFiltersChangedEvent} from './views/FilterDialogView.js';
import {HiddenView} from './views/HiddenView.js';
import {KeyboardShortcutsDialog} from './views/KeyboardShortcutsDialog.js';
import {SettingsView} from './views/SettingsView.js';
import {ThreadListView} from './views/ThreadListView.js';
import {TrackingView} from './views/TrackingView.js';
import {View} from './views/View.js';

if (!isMobileUserAgent())
  document.documentElement.classList.add('desktop');

// Run this as early as possible to minimize flash of white on reload.
Themes.apply();

let currentView_: View;
let appShell_: AppShell;

const UNIVERSAL_QUERY_PARAMETERS =
    ['bundle', 'label', 'days', 'offices', 'finalVersion'];
let router = new Router(UNIVERSAL_QUERY_PARAMETERS);

let longTasks_: LongTasks;
async function updateLongTaskTracking() {
  // Read this setting out of local storage so we don't block on reading
  // settings from the network to set this up.
  if (await IDBKeyVal.getDefault().get(ServerStorage.KEYS.TRACK_LONG_TASKS)) {
    // Since updateLongTaskTracking is called multiple times, there can be a
    // race with the above await call, so ensure we don't create it twice.
    if (!longTasks_) {
      longTasks_ = new LongTasks();
      document.body.append(longTasks_);
    }
  } else if (longTasks_) {
    longTasks_.remove();
  }
}
updateLongTaskTracking();

enum VIEW {
  Calendar,
  Compose,
  Hidden,
  Settings,
  Todo,
  Tracking,
  Triage,
}

async function routeToCurrentLocation() {
  await router.run(window.location, true);
}

window.onpopstate = () => {
  routeToCurrentLocation();
};

router.add('/compose', async (params) => {
  let shouldHideToolbar = false;
  for (let param of Object.entries(params)) {
    // TODO: Directly check for the compose parameters instead of doing this.
    if (!UNIVERSAL_QUERY_PARAMETERS.includes(param[0])) {
      shouldHideToolbar = true;
      break;
    }
  }

  if (shouldHideToolbar)
    preventUpdates();
  await setView(VIEW.Compose, params, shouldHideToolbar);
});
router.add('/track', async (_params) => {
  await setView(VIEW.Tracking);
});
router.add('/', routeToTriage);
router.add('/triage', routeToTriage);
router.add('/todo', async (params) => {
  await setView(VIEW.Todo, params);
});
router.add('/hidden', async (_params) => {
  await setView(VIEW.Hidden);
});
router.add('/calendar', async (_parans) => {
  await setView(VIEW.Calendar);
});
router.add('/settings', async (_parans) => {
  await setView(VIEW.Settings);
});

async function routeToTriage(params: any) {
  await setView(VIEW.Triage, params);
}

function getView() {
  return currentView_;
}

async function createModel(viewType: VIEW, params?: any) {
  switch (viewType) {
    case VIEW.Calendar:
      return await getCalendarModel();

    case VIEW.Compose:
      return new ComposeModel();

    case VIEW.Tracking:
      return new TrackingModel();

    case VIEW.Todo:
      let todoModel = await getTodoModel(params.finalVersion === 'true');
      todoModel.setViewFilters(params.label, params.days);
      return todoModel;

    case VIEW.Triage:
      let triageModel = await getTriageModel(params.offices);
      triageModel.setViewFilters(params.label, params.days);
      return triageModel;

    case VIEW.Settings:
      return null;

    case VIEW.Hidden:
      return null;

    default:
      // Throw instead of asserting here so that TypeScript knows that this
      // function never returns undefined.
      throw new Error('This should never happen.');
  }
}

async function createView(viewType: VIEW, model: Model|null, params?: any) {
  switch (viewType) {
    case VIEW.Calendar:
      return new CalendarView(model as Calendar);

    case VIEW.Compose:
      return new ComposeView(model as ComposeModel, params, getMailProcessor);

    case VIEW.Tracking:
      return new TrackingView(model as TrackingModel);

    case VIEW.Todo:
      return new ThreadListView(
          <TodoModel>model, appShell_, await getSettings(), '/triage', true);

    case VIEW.Triage:
      return new ThreadListView(
          <TriageModel>model, appShell_, await getSettings(), '/todo');

    case VIEW.Settings:
      return new SettingsView(await getSettings());

    case VIEW.Hidden:
      return new HiddenView(appShell_, await getSettings());

    default:
      // Throw instead of asserting here so that TypeScript knows that this
      // function never returns undefined.
      throw new Error('This should never happen.');
  }
}

let viewGeneration = 0;
async function setView(
    viewType: VIEW, params?: any, shouldHideToolbar?: boolean) {
  let thisViewGeneration = ++viewGeneration;

  appShell_.showToolbar(!shouldHideToolbar);
  appShell_.showViewAndFilterToggles(false);
  // TODO: Make this work for VIEW.Hidden as well.
  appShell_.showOverflowMenuButton(
      viewType === VIEW.Todo || viewType === VIEW.Triage);
  appShell_.setQueryParameters(params);

  if (currentView_)
    currentView_.tearDown();

  let model = defined(await createModel(viewType, params));
  // Abort if we transitioned to a new view while this one was being created.
  if (thisViewGeneration !== viewGeneration)
    return;

  let view = defined(await createView(viewType, model, params));
  // Abort if we transitioned to a new view while this one was being created.
  if (thisViewGeneration !== viewGeneration) {
    view.tearDown();
    return;
  }

  currentView_ = view;
  appShell_.setContent(currentView_);
  await currentView_.init();
}

let isUpdating_ = false;
let shouldUpdate_ = true;

function preventUpdates() {
  shouldUpdate_ = false;
}

function resetModels() {
  calendarModel_ = undefined;
  triageModel_ = undefined;
  todoModel_ = undefined;
}

let calendarModel_: Calendar|undefined;
async function getCalendarModel() {
  if (!calendarModel_)
    calendarModel_ = new Calendar(await getSettings());
  return calendarModel_;
}

let triageModel_: TriageModel|undefined;
async function getTriageModel(offices?: string) {
  if (!triageModel_)
    triageModel_ = new TriageModel(await getSettings(), offices);
  return triageModel_;
}

let todoModel_: TodoModel|undefined;
async function getTodoModel(finalVersion?: boolean) {
  if (!todoModel_) {
    let settings = await getSettings();
    todoModel_ = new TodoModel(
        settings.get(ServerStorage.KEYS.VACATION),
        settings.get(ServerStorage.KEYS.ALLOWED_PIN_COUNT),
        settings.get(ServerStorage.KEYS.ALLOWED_MUST_DO_COUNT),
        settings.get(ServerStorage.KEYS.ALLOWED_URGENT_COUNT), finalVersion);
  }
  return todoModel_;
}

let mailProcessor_: MailProcessor;
async function getMailProcessor() {
  if (!mailProcessor_) {
    mailProcessor_ = new MailProcessor(await getSettings());
    await mailProcessor_.init();
  }
  return mailProcessor_;
}

async function updateBackground() {
  let settings = await getSettings();
  let background = settings.get(ServerStorage.KEYS.BACKGROUND);
  Themes.setOverrideBackground(background);

  let theme = settings.get(ServerStorage.KEYS.THEME);
  Themes.setTheme(theme);
}

document.body.addEventListener(ViewFiltersChangedEvent.NAME, async (e) => {
  let event = e as ViewFiltersChangedEvent;
  // TODO: This is heavyweight and jarring to the user. All we really need is
  // to dispatch a ThreadListChangedEvent on the model.
  resetModels();
  // TODO: Properly handle if there are existing query parameters.
  await router.run(
      window.location.pathname +
      `?label=${event.label}&days=${event.days}&offices=${
          event.offices}&finalVersion=${event.finalVersion}`);
});

async function onLoad() {
  let serverStorage = await getServerStorage();
  serverStorage.addEventListener(ServerStorageUpdateEventName, async () => {
    updateBackground();
    // Rerender the current view on settings changes in case a setting would
    // change it's behavior, e.g. duration of the countdown timer or sort order
    // of queues.
    resetModels();
    await routeToCurrentLocation();
  });

  appShell_ = new AppShell();
  appShell_.addEventListener(BackEvent.NAME, async () => {
    await getView().goBack();
  });
  appShell_.addEventListener(ToggleViewEvent.NAME, () => {
    getView().toggleView();
  });
  appShell_.addEventListener(OverflowMenuOpenEvent.NAME, (e: Event) => {
    let container = (e as OverflowMenuOpenEvent).container;
    getView().openOverflowMenu(container);
  });
  document.body.append(appShell_);

  // Show an indicator for the whole life of the initial update since
  // routeToCurrentLocation can take a long time in some cases.
  let progress = AppShell.updateLoaderTitle('Main.onLoad', 1, 'Updating...');
  try {
    await routeToCurrentLocation();
    updateBackground();
    await update();
    // Instantiate the TodoModel even if we're not in the Todo view so that the
    // favicon is updated with the must do count.
    await getTodoModel();
  } finally {
    progress.incrementProgress();
  }

  // Wait until we've fetched all the threads before trying to process updates
  // regularly. Do these updates silently except when there are new threads to
  // process, which is handled by MailProcessor.
  setInterval(updateSilently, 1000 * 60);

  let settings = await getSettings();
  if (settings.get(ServerStorage.KEYS.TRACK_LONG_TASKS)) {
    await IDBKeyVal.getDefault().set(
        ServerStorage.KEYS.TRACK_LONG_TASKS, 'true');
  } else {
    await IDBKeyVal.getDefault().del(ServerStorage.KEYS.TRACK_LONG_TASKS);
  }
  await updateLongTaskTracking();
  await setupReloadOnVersionChange();
}

onLoad();

let version_: number;
async function setupReloadOnVersionChange() {
  let db = firestore();
  let doc = db.collection('global').doc('version');
  let data = await doc.get();
  if (data.exists)
    version_ = defined(data.data()).version;

  doc.onSnapshot(async (snapshot) => {
    if (version_ != defined(snapshot.data()).version)
      reloadSoon();
  });
}

function reloadSoon() {
  // Prevent updates since the application logic may change with the new
  // version. This lets us have confidence that old clients will reload before
  // they do significant processing work.
  preventUpdates();

  let dialog: HTMLDialogElement;

  let container = document.createElement('div');
  container.append(
      'A new version of maketime is available. This window will reload in 60 seconds.');

  let reloadButton = document.createElement('button');
  reloadButton.className = 'mktime-button';
  reloadButton.append('reload now');
  reloadButton.onclick = () => reload();

  let close = document.createElement('button');
  close.className = 'mktime-button';
  close.append('close');
  close.onclick = () => dialog.close();

  let buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    justify-content: flex-end;
  `;
  buttonContainer.append(reloadButton, close);
  container.append(buttonContainer);
  dialog = showDialog(container);

  setTimeout(() => reload(), 60000);
}

function reload() {
  window.location.reload();
}

const DAILY_LOCAL_UPDATES_KEY = 'daily-local-updates';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Updates to things stored in local storage. This should not be used for things
// that should happen once per day globally since the user might have maketime
// open on multiple clients.
async function dailyLocalUpdates() {
  let lastUpdateTime: number|undefined =
      await IDBKeyVal.getDefault().get(DAILY_LOCAL_UPDATES_KEY);
  if (lastUpdateTime && (Date.now() - lastUpdateTime) < ONE_DAY_MS)
    return;

  await (await SendAs.getDefault()).update();
  await Contacts.getDefault().update();
  await gcStaleThreadData();

  await IDBKeyVal.getDefault().set(DAILY_LOCAL_UPDATES_KEY, Date.now());
}

async function gcStaleThreadData() {
  let currentWeekNumber = getCurrentWeekNumber();
  let keys = await IDBKeyVal.getDefault().keys();
  for (let key of keys) {
    let match = key.match(/^thread-(\d+)-\d+$/);
    if (!match)
      continue;

    // At this point, any threads in the inbox still should have been updated
    // to the current week. So anything in another week should be stale
    // and can be deleted.
    let weekNumber = Number(match[1]);
    if (weekNumber != currentWeekNumber)
      await IDBKeyVal.getDefault().del(key);
  }
}

let silentUpdatePromise: Promise<void>|null;
async function updateSilently() {
  silentUpdatePromise = doUpdate_();
  await silentUpdatePromise;
  silentUpdatePromise = null;
}

export async function update() {
  let progress = AppShell.updateLoaderTitle('Main.update', 1, 'Updating...');
  try {
    // If there's a silent update in progress, still want to show the updating
    // text when a non-silent update is attempted so there's some indication
    // something is happening.
    if (silentUpdatePromise)
      await silentUpdatePromise;
    await doUpdate_();
  } finally {
    progress.incrementProgress();
  }
}

async function doUpdate_() {
  if (!shouldUpdate_ || !navigator.onLine)
    return;

  // Reload once a day at the start of the day to ensure people don't have
  // excessively stale clients open.
  // Don't reload until after 3am to minimize the likelihood of reloading at
  // midnight when the user is active.
  let today = new Date();
  let start = new Date(window.performance.timing.navigationStart);
  if (today.getHours() > 2 &&
      (start.getDate() !== today.getDate() ||
       start.getMonth() !== today.getMonth())) {
    // If the tab is hidden, reload right away. If it's visible, show a
    // notification to the user so they can save state if they woulld like to.
    if (document.visibilityState === 'visible')
      reloadSoon();
    else
      reload();
    // Since the application logic may change with the new version, don't
    // proceed with the update. This lets us have confidence that old clients
    // will reload before they do significant processing work.
    return;
  }

  // update can get called before any views are setup due to visibilitychange
  // and online handlers
  let view = await getView();
  if (!view || isUpdating_)
    return;
  isUpdating_ = true;

  try {
    await (await getMailProcessor()).process();

    // Don't init the calendar model here as we don't want to force load all the
    // calendar events every time someone loads maketime. But once they've
    // viewed the calendar onces, then pull in event updates from then on since
    // those are cheap and are needed to do continual colorizing.
    if (calendarModel_)
      calendarModel_.updateEvents();

    await dailyLocalUpdates();
  } catch (e) {
    // TODO: Move this to Net.js once we've made it so that all network
    // requests that fail due to being offline get retried.
    if (processErrorMessage(e) === NETWORK_OFFLINE_ERROR_MESSAGE) {
      AppShell.updateTitle(
          CONNECTION_FAILURE_KEY, 'Having trouble connecting to internet...');
    } else {
      throw e;
    }
  } finally {
    isUpdating_ = false;
  }
}

window.addEventListener(CONNECTION_FAILURE_KEY, () => {
  // Net.js fires this when a network request succeeds, which indicates we're
  // no longer offline.
  AppShell.updateTitle(CONNECTION_FAILURE_KEY);
});

// Make sure links open in new tabs.
document.body.addEventListener('click', async (e) => {
  for (let node of e.composedPath()) {
    if ((node as Element).tagName === 'A') {
      let anchor = <HTMLAnchorElement>node;
      // For navigations will just change the hash scroll the item into view
      // (e.g. for links in a newsletter). In theory we could allow the default
      // action to go through, but that would call onpopstate and we'd need to
      // get onpopstate to not route to the current location. This seems easier.
      // This doesn't update the url with the hash, but that might be better
      // anyways.
      if (location.hash !== anchor.hash && location.origin === anchor.origin &&
          location.pathname === anchor.pathname) {
        e.preventDefault();
        let id = anchor.hash.replace('#', '');
        let target = document.getElementById(id);
        if (target)
          target.scrollIntoView();
        return;
      }

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
  if (element.tagName == 'INPUT' &&
      !NON_TEXT_INPUT_TYPES.includes((<HTMLInputElement>element).type))
    return true;

  if (element.tagName == 'TEXTAREA')
    return true;

  let parent: Element|null = element;
  while (parent) {
    let userModify = getComputedStyle(parent).webkitUserModify;
    if (userModify && userModify.startsWith('read-write'))
      return true;
    parent = parent.parentElement;
  }

  return false;
}

document.addEventListener('visibilitychange', async () => {
  let view = await getView();
  if (view)
    view.visibilityChanged();

  if (document.visibilityState == 'visible')
    await update();
});

document.body.addEventListener('keydown', async (e) => {
  if (!getView())
    return;

  if (isEditable(<Element>e.target))
    return;

  if (e.key == '?') {
    new KeyboardShortcutsDialog();
    return;
  }

  if (getView().dispatchShortcut && !e.altKey)
    await getView().dispatchShortcut(e);
});

window.addEventListener('resize', () => {
  let view = getView();
  if (view)
    view.forceRender();
});

window.addEventListener('error', (e) => {
  // Want to process this in case we hit a firestore internal error and need to
  // reload.
  processErrorMessage(e);
  ErrorLogger.log(
      e.error, JSON.stringify(e, ['body', 'error', 'message', 'stack']));
});

const FIRESTORE_INTERNAL_ERROR = `internal assertion failed`;
const NETWORK_OFFLINE_ERROR_MESSAGE =
    'A network error occurred. Are you offline?';
const FETCH_ERROR_MESSAGE =
    'A network error occurred, and the request could not be completed.';

// See https://github.com/firebase/firebase-js-sdk/issues/1642.
function reloadOnFirestoreInternalError(message: string) {
  if (message && message.toLowerCase().includes('firestore') &&
      message.toLowerCase().includes(FIRESTORE_INTERNAL_ERROR))
    reload();
}

// Different promise types stow a human understandable message in different
// places. :( Also, if we catch via a try/catch, then we need to pass the
// exception itself as an argument this function instead of e.reason.
function processErrorMessage(reason: any) {
  // Case: throw new Error('msg');
  let message = reason.message;

  // Cases: (gapi network failure) || fetch network failure
  let error = (reason.result && reason.result.error) || reason.error;
  // Case: gapi network failures.
  if (!message)
    message = error && error.message;

  if (error && error.code === -1 && message === FETCH_ERROR_MESSAGE)
    message = NETWORK_OFFLINE_ERROR_MESSAGE;

  reloadOnFirestoreInternalError(message);
  return message;
}

window.addEventListener('unhandledrejection', (e) => {
  let reason = e.reason;
  // 401 means the credentials are invalid and you probably need to 2 factor.
  if (reason && reason.status == 401)
    reload();

  // Plain stringify will skip a bunch of things, so manually list out
  // everything we might care about. Add to this list over time as we find
  // other error types.
  let details = JSON.stringify(
      reason, ['stack', 'message', 'body', 'result', 'error', 'code']);

  let message = processErrorMessage(e.reason);
  reloadOnFirestoreInternalError(message);

  if (message)
    ErrorLogger.log(message, details);
  else
    ErrorLogger.log(details);
});

window.addEventListener('offline', () => {
  AppShell.updateTitle('main.offline', 'No network connection...');
});

window.addEventListener('online', () => {
  AppShell.updateTitle('main.offline');
  update();
});
