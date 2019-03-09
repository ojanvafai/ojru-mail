import {Action} from '../Actions.js';
import {compareDates, defined} from '../Base.js';
import {firestoreUserCollection, login} from '../BaseMain.js';
import {ThreadListModel, TriageResult} from '../models/ThreadListModel.js';
import {Settings} from '../Settings.js';
import {Thread, ThreadMetadataKeys} from '../Thread.js';

import {AppShell} from './AppShell.js';
import {ThreadListView} from './ThreadListView.js';
import {View} from './View.js';

let FIRESTORE_KEYS = [
  ThreadMetadataKeys.blocked,
  ThreadMetadataKeys.queued,
  ThreadMetadataKeys.muted,
  ThreadMetadataKeys.archivedByFilter,
];

let formattingOptions: {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
} = {
  month: 'short',
  day: 'numeric',
}

let DAY_MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, formattingOptions);

class HiddenModel extends ThreadListModel {
  constructor(private keyIndex_: number) {
    // For muted, don't put undo items back in the inbox.
    super(false, true);

    if (this.queryKey_() === ThreadMetadataKeys.blocked) {
      let metadataCollection =
          firestoreUserCollection().doc('threads').collection('metadata');
      this.setQuery(metadataCollection.orderBy('blocked', 'asc'));
    } else {
      let metadataCollection =
          firestoreUserCollection().doc('threads').collection('metadata');
      this.setQuery(metadataCollection.where(this.queryKey_(), '==', true));
    }
  }

  private queryKey_() {
    return FIRESTORE_KEYS[this.keyIndex_];
  }

  defaultCollapsedState(_groupName: string) {
    return false;
  }

  compareThreads(a: Thread, b: Thread) {
    // Reverse sort by blocked date for the blocked view.
    if (this.queryKey_() === ThreadMetadataKeys.blocked)
      return compareDates(b.getBlockedDate(), a.getBlockedDate());
    else
      return this.compareDates(a, b);
  }

  // There's no priorities to show, but when in queued, we want the label to
  // show the group so you can see which group it's queued into and in blocked
  // want to see what date it's blocked until.
  getThreadRowLabel(thread: Thread) {
    switch (this.queryKey_()) {
      case ThreadMetadataKeys.blocked:
        // If we load the page and blocked threads are removed while viewing,
        // then the thread will be unblocked in some cases while still
        // temporarily being visible in this view.
        if (thread.isBlocked())
          return DAY_MONTH_FORMATTER.format(thread.getBlockedDate());
        return '';

      case ThreadMetadataKeys.queued:
        return thread.getLabel() || '';
    }
    return '';
  }

  getGroupName(_thread: Thread) {
    return FIRESTORE_KEYS[this.keyIndex_];
  }

  // Moving one of these types out of hidden into a priority or blocked means we
  // need to mvoe it back into the inbox.
  triageMovesToInbox_() {
    return FIRESTORE_KEYS[this.keyIndex_] === ThreadMetadataKeys.muted ||
        FIRESTORE_KEYS[this.keyIndex_] === ThreadMetadataKeys.archivedByFilter;
  }

  protected async markTriagedInternal(thread: Thread, destination: Action) {
    super.markTriagedInternal(thread, destination, this.triageMovesToInbox_());
  }

  // Override the undo action for muted and archive since we need to have them
  // set the appropriate state for removeing the thread from the inbox again if
  // the thread was already put back in the inbox.
  async handleUndoAction(action: TriageResult) {
    switch (FIRESTORE_KEYS[this.keyIndex_]) {
      case ThreadMetadataKeys.muted:
        await action.thread.setMuted();
        return;

      case ThreadMetadataKeys.archivedByFilter:
        await action.thread.archive(true);
        return;

      default:
        await super.handleUndoAction(action);
    }
  }
}

export class HiddenView extends View {
  private threadListView_?: ThreadListView;
  private select_: HTMLSelectElement;

  constructor(private appShell_: AppShell, private settings_: Settings) {
    super();

    let container = document.createElement('div');
    this.append(container);

    this.select_ = document.createElement('select');
    for (let key of FIRESTORE_KEYS) {
      let option = document.createElement('option');
      option.append(key);
      this.select_.append(option);
    }
    this.select_.addEventListener('change', () => this.handleSelectChange_());

    container.append('Show: ', this.select_);
  }

  async init() {
    await login();
    this.render_();
  }

  render_() {
    // If we're in view one mode, hide the back arrow since we're going back to
    // the threadlist, but with a new ThreadListView.
    this.appShell_.showBackArrow(false);

    let model = new HiddenModel(this.select_.selectedIndex);

    if (this.threadListView_)
      this.threadListView_.remove();
    this.threadListView_ =
        new ThreadListView(model, this.appShell_, this.settings_);
    this.append(this.threadListView_);
  }

  async handleSelectChange_() {
    this.render_();
  }

  async goBack() {
    await defined(this.threadListView_).goBack();
  }

  async dispatchShortcut(e: KeyboardEvent) {
    await defined(this.threadListView_).dispatchShortcut(e);
  };

  async takeAction(action: Action) {
    await defined(this.threadListView_).takeAction(action);
  }
}
window.customElements.define('mt-hidden-view', HiddenView);