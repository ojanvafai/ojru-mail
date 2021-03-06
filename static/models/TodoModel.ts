import type * as firebase from 'firebase/app';
import { compareDates, defined, notNull, setFaviconCount } from '../Base.js';
import { firestoreUserCollection } from '../BaseMain.js';
import { ServerStorage } from '../ServerStorage.js';
import { Settings } from '../Settings.js';
import {
  MUST_DO_PRIORITY_NAME,
  PINNED_PRIORITY_NAME,
  Priority,
  STUCK_LABEL_NAME,
  ThreadMetadataKeys,
  URGENT_PRIORITY_NAME,
} from '../Thread.js';
import { Thread } from '../Thread.js';

import { ThreadListChangedEvent, ThreadListModel } from './ThreadListModel.js';

export const RETRIAGE_LABEL_NAME = 'Retriage';
export const NO_OFFICES = 'none';
export const IMPORTANT_NAME = 'important';

export class TodoModel extends ThreadListModel {
  private threadsData_?: firebase.firestore.DocumentData;
  private sortCount_: number;
  private faviconCount_: number;

  constructor(settings_: Settings) {
    // TODO: Fix this to be less gross. The forceTriageIndex should match the
    // index of the hasLabel query in the setQueries call below.
    // Instead make it so that setQuery only takes a single query and there's an
    // explict setForceTriageQuery.
    let forceTriageIndex = 0;
    super(settings_, forceTriageIndex);
    this.sortCount_ = 0;
    this.faviconCount_ = 0;

    let threadsDoc = firestoreUserCollection().doc('threads');
    let metadataCollection = threadsDoc.collection('metadata');

    // Fetch hasLabel first since that gets sorted at the top and is often what
    // the user wants to see first.
    this.setQueries(
      metadataCollection.where(ThreadMetadataKeys.hasLabel, '==', true),
      metadataCollection.where(ThreadMetadataKeys.hasPriority, '==', true),
    );

    threadsDoc.onSnapshot((snapshot) => {
      // Don't want snapshot updates to get called in response to local sort
      // changes since we modify the in memory data locally. The downside to
      // this is that we technically have a race if the sort order changes on a
      // different client at the same time as this one.
      if (this.sortCount_ > 0) this.sortCount_--;

      if (this.sortCount_) return;

      this.threadsData_ = snapshot.data();
      this.handleSortChanged_();
    });
  }

  postProcessThreads(threads: Thread[]) {
    let faviconCount = threads.reduce((accumulator: number, currentValue: Thread) => {
      let priorityId = currentValue.getPriorityId();
      let shouldCount = priorityId === Priority.Pin || priorityId === Priority.MustDo;
      return accumulator + (shouldCount ? 1 : 0);
    }, 0);

    // The favicon doesn't support showing 3 digets so cap at 99.
    faviconCount = Math.min(99, faviconCount);
    if (faviconCount !== this.faviconCount_) {
      this.faviconCount_ = faviconCount;
      setFaviconCount(faviconCount);
    }
  }

  handleSortChanged_() {
    this.sort();
    this.dispatchEvent(new ThreadListChangedEvent());
  }

  protected shouldShowThread(thread: Thread) {
    if (thread.needsTriage()) {
      let vacation = this.settings_.get(ServerStorage.KEYS.VACATION);
      if (vacation && vacation !== thread.getLabel()) {
        return false;
      }
    } else {
      let priority = thread.getPriorityId();
      if (!priority) return false;

      if (
        this.settings_.get(ServerStorage.KEYS.VACATION) &&
        priority !== Priority.MustDo &&
        priority !== Priority.Pin
      )
        return false;
    }
    return super.shouldShowThread(thread);
  }

  static getTriageGroupName(settings: Settings, thread: Thread) {
    if (thread.isStuck()) return STUCK_LABEL_NAME;

    if (thread.needsRetriage()) return RETRIAGE_LABEL_NAME;

    if (
      thread.isImportant() &&
      settings.get(ServerStorage.KEYS.PRIORITY_INBOX) === Settings.SINGLE_GROUP
    ) {
      return IMPORTANT_NAME;
    }

    return notNull(thread.getLabel());
  }

  getGroupName(thread: Thread) {
    if (thread.forceTriage()) {
      return TodoModel.getTriageGroupName(this.settings_, thread);
    }
    return notNull(thread.getPriority());
  }

  allowedCount(groupName: string) {
    switch (groupName) {
      case PINNED_PRIORITY_NAME:
        return this.settings_.get(ServerStorage.KEYS.ALLOWED_PIN_COUNT);
      case MUST_DO_PRIORITY_NAME:
        return this.settings_.get(ServerStorage.KEYS.ALLOWED_MUST_DO_COUNT);
      case URGENT_PRIORITY_NAME:
        return this.settings_.get(ServerStorage.KEYS.ALLOWED_URGENT_COUNT);
    }
    // 0 represents no limit.
    return 0;
  }

  pinnedCount() {
    return this.getThreads().filter((x) => x.getPriorityId() === Priority.Pin).length;
  }

  mustDoCount() {
    return this.getThreads().filter((x) => x.getPriorityId() === Priority.MustDo).length;
  }

  urgentCount() {
    return this.getThreads().filter((x) => x.getPriorityId() === Priority.Urgent).length;
  }

  private getSortData_(priority: number) {
    return this.threadsData_ && this.threadsData_[this.getSortKey_(priority)];
  }

  static compareTriageThreads(settings: Settings, a: Thread, b: Thread) {
    // Sort by queue, then by date.
    let aGroup = TodoModel.getTriageGroupName(settings, a);
    let bGroup = TodoModel.getTriageGroupName(settings, b);

    if (aGroup === bGroup) {
      // Sort within retriage by priority first.
      if (aGroup === RETRIAGE_LABEL_NAME && a.getPriorityId() !== b.getPriorityId()) {
        // TODO: Assert these are defined and change Thread.comparePriorities to
        // required defined priorities once clients have updated.
        let aPriority = a.getPriorityId();
        let bPriority = b.getPriorityId();
        return Thread.comparePriorities(aPriority, bPriority);
      }
      return ThreadListModel.compareDates(a, b);
    }

    return settings.getQueueSettings().queueNameComparator(aGroup, bGroup);
  }

  protected compareThreads(a: Thread, b: Thread) {
    let aPinned = a.getPriorityId() === Priority.Pin;
    let bPinned = b.getPriorityId() === Priority.Pin;

    // Pull pinned threads out first
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    if (a.forceTriage() || b.forceTriage()) {
      if (a.forceTriage() && b.forceTriage())
        return TodoModel.compareTriageThreads(this.settings_, a, b);
      return a.forceTriage() ? -1 : 1;
    }

    let aPriority = defined(a.getPriorityId());
    let bPriority = defined(b.getPriorityId());

    // Sort by priority, then by manual sort order, then by date.
    if (aPriority !== bPriority) return Thread.comparePriorities(aPriority, bPriority);

    // Intentionally put manual sort as higher priority than read state so that
    // you can manually sort unread items into the list of read items below.
    let sortData = this.getSortData_(aPriority);
    if (sortData) {
      let aIndex = sortData.indexOf(a.id);
      let bIndex = sortData.indexOf(b.id);
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return -1;
        if (bIndex === -1) return 1;
        return aIndex - bIndex;
      }
    }

    // Sort unread items to the top of priority buckets except for pinned. Don't
    // need to check bPinned since aPriority === bPriority by this point.
    if (!aPinned && a.isUnread() != b.isUnread()) return a.isUnread() ? -1 : 1;

    return compareDates(a.getLastModifiedDate(), b.getLastModifiedDate());
  }

  private getSortKey_(priority: number) {
    return `sort-priority-${priority}`;
  }

  // TODO: only enable the sort buttons for priority group names and move this
  // into ThreadListModel.
  setSortOrder(threads: Thread[]) {
    let threadIds = threads.map((x) => x.id);

    let update: any = {};
    let priorityId = defined(threads[0].getPriorityId());
    let sortKey = this.getSortKey_(priorityId);
    update[sortKey] = threadIds;

    // Update the in memory model right away so the UI is updated immediately.
    if (this.threadsData_) {
      this.threadsData_[sortKey] = threadIds;
      this.handleSortChanged_();
    }

    this.sortCount_++;
    let threadsDoc = firestoreUserCollection().doc('threads');
    // TODO: Should probably debounce this so that holding down the sort key
    // doesn't result in a flurry of network activity.
    threadsDoc.set(update, { merge: true });
  }
}
