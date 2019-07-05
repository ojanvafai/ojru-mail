import {firebase} from '../third_party/firebasejs/5.8.2/firebase-app.js';

import {assert, defined, getCurrentWeekNumber, getPreviousWeekNumber, parseAddressList, ParsedAddress, USER_ID} from './Base.js';
import {firestoreUserCollection} from './BaseMain.js';
import {IDBKeyVal} from './idb-keyval.js';
import {send} from './Mail.js';
import {gapiFetch} from './Net.js';
import {ProcessedMessageData} from './ProcessedMessageData.js';
import {QueueNames} from './QueueNames.js';

let memoryCache_: Map<string, Thread> = new Map();

interface SerializedMessages {
  historyId: string;
  messages: gapi.client.gmail.Message[];
}

export class UpdatedEvent extends Event {
  static NAME = 'thread-updated';
  constructor() {
    super(UpdatedEvent.NAME);
  }
}

export class InProgressChangedEvent extends Event {
  static NAME = 'in-progress-changed';
  constructor() {
    super(InProgressChangedEvent.NAME, {bubbles: true});
  }
}

export enum ReplyType {
  ReplyAll = 'reply all',
  Reply = 'reply',
  Forward = 'forward',
}

interface Repeat {
  type: number;
}

// Keep ThreadMetadataUpdate and ThreadMetadataKeys in sync with any changes
// here.
export interface ThreadMetadata {
  historyId: string;
  messageIds: string[];
  timestamp: number;
  retriageTimestamp?: number;
  priorityId?: number;
  labelId?: number;
  repeat?: Repeat;
  needsRetriage?: boolean;
  // These booleans are so we can query for things that have a label but still
  // orderBy timestamp. We can just priorityId>0 because firestore doesn't
  // support range queries on a different field than the orderBy field.
  hasLabel?: boolean;
  hasPriority?: boolean;
  queued?: boolean;
  blocked?: boolean|number;
  due?: number;
  // Record whether we marked an item as overdue so we don't keep marking it
  // overdue repeatedly unless the user changes the due date again.
  dueDateExpired?: boolean;
  muted?: boolean;
  archivedByFilter?: boolean;
  finalVersion?: boolean;
  // Threads that were added back to the inbox in maketime, so syncWithGmail
  // should move them into the inbox instead of clearing their metadata.
  moveToInbox?: boolean;
  // Count of number of messages read. We don't attempt to keep this in sync
  // with gmail's sense of read state.
  readCount?: number;
  countToArchive?: number;
  countToMarkRead?: number;
}

// Want strong typing on all update calls, but don't want to write historyId and
// messageIds on each of them and want to allow FieldValues without needing all
// the getters to have to manage them.
// TODO: Find a more don't-repeat-yourself way of doing this?
export interface ThreadMetadataUpdate {
  historyId?: string|firebase.firestore.FieldValue;
  messageIds?: string[]|firebase.firestore.FieldValue;
  timestamp?: number|firebase.firestore.FieldValue;
  retriageTimestamp?: number|firebase.firestore.FieldValue;
  priorityId?: number|firebase.firestore.FieldValue;
  labelId?: number|firebase.firestore.FieldValue;
  repeat?: Repeat|firebase.firestore.FieldValue;
  needsRetriage?: boolean|firebase.firestore.FieldValue;
  hasLabel?: boolean|firebase.firestore.FieldValue;
  hasPriority?: boolean|firebase.firestore.FieldValue;
  queued?: boolean|firebase.firestore.FieldValue;
  blocked?: boolean|number|firebase.firestore.FieldValue;
  due?: boolean|number|firebase.firestore.FieldValue;
  dueDateExpired?: boolean|firebase.firestore.FieldValue;
  muted?: boolean|firebase.firestore.FieldValue;
  archivedByFilter?: boolean|firebase.firestore.FieldValue;
  finalVersion?: boolean|firebase.firestore.FieldValue;
  moveToInbox?: boolean|firebase.firestore.FieldValue;
  readCount?: number|firebase.firestore.FieldValue;
  countToArchive?: number|firebase.firestore.FieldValue;
  countToMarkRead?: number|firebase.firestore.FieldValue;
}

// Firestore queries take the key as a string. Use an enum so we can avoid silly
// typos in string literals.
// TODO: Is there a way to do this without manually keeping things in sync?
export enum ThreadMetadataKeys {
  historyId = 'historyId',
  messageIds = 'messageIds',
  timestamp = 'timestamp',
  retriageTimestamp = 'retriageTimestamp',
  priorityId = 'priorityId',
  labelId = 'labelId',
  repeat = 'repeat',
  needsRetriage = 'needsRetriage',
  hasLabel = 'hasLabel',
  hasPriority = 'hasPriority',
  queued = 'queued',
  blocked = 'blocked',
  due = 'due',
  dueDateExpired = 'dueDateExpired',
  muted = 'muted',
  archivedByFilter = 'archivedByFilter',
  finalVersion = 'finalVersion',
  moveToInbox = 'moveToInbox',
  readCount = 'readCount',
  countToArchive = 'countToArchive',
  countToMarkRead = 'countToMarkRead',
}

let FWD_THREAD_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  weekday: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  timeZoneName: 'short',
});

// The number values get stored in firestore, so should never be changed.
export enum Priority {
  NeedsFilter = 1,
  MustDo = 2,
  Urgent = 3,
  Backlog = 4,
  Pin = 5,
}

// The number values get stored in firestore, so should never be changed.
export enum RepeatType {
  Daily = 1,
}

export const NEEDS_FILTER_PRIORITY_NAME = 'Filter';
export const PINNED_PRIORITY_NAME = 'Pin';
export const MUST_DO_PRIORITY_NAME = 'Must do';
export const URGENT_PRIORITY_NAME = 'Urgent';
export const BACKLOG_PRIORITY_NAME = 'Backlog';
export const BLOCKED_LABEL_NAME = 'Stuck';
export const OVERDUE_LABEL_NAME = 'Overdue';
export const FALLBACK_LABEL_NAME = 'No label';

export const PrioritySortOrder = [
  Priority.Pin,
  Priority.MustDo,
  Priority.Urgent,
  Priority.NeedsFilter,
  Priority.Backlog,
];

// Use negative values for built-in labels.
export enum BuiltInLabelIds {
  Blocked = -1,
  Fallback = -2,
}

export class Thread extends EventTarget {
  private processed_: ProcessedMessageData;
  private queueNames_: QueueNames;
  private fetchPromise_:
      Promise<gapi.client.Response<gapi.client.gmail.Thread>>|null = null;
  // Keep track of messages sent until an update pulls them in properly so that
  // we can queue up archives/mark-reads with the right count of messages to
  // archive/mark-read.
  private sentMessageIds_: string[];
  private actionInProgress_?: boolean;
  private actionInProgressTimestamp_?: number;

  constructor(public id: string, private metadata_: ThreadMetadata) {
    super();

    this.processed_ = new ProcessedMessageData();
    this.queueNames_ = QueueNames.create();
    this.sentMessageIds_ = [];
  }

  private messageCount_() {
    let count = this.metadata_.messageIds.length + this.sentMessageIds_.length;
    assert(
        count,
        `Can't modify thread before message details have loaded. Please wait and try again.`);
    return count;
  }

  oldMetadataState(updates: ThreadMetadataUpdate) {
    let oldState: any = {};
    let fullState = this.metadata_ as any;
    for (let key in updates) {
      if (key in fullState)
        oldState[key] = fullState[key];
      else
        oldState[key] = firebase.firestore.FieldValue.delete();
    }
    return oldState;
  }

  // Returns the old values for all the fields being updated so that undo can
  // restore them.
  async updateMetadata(updates: ThreadMetadataUpdate) {
    await this.getMetadataDocument_().update(updates);
    this.dispatchEvent(new UpdatedEvent());
    if (this.actionInProgress_) {
      this.setActionInProgress(false);
      this.dispatchEvent(new InProgressChangedEvent());
    }
  }

  private static clearedMetadata_(removeFromInbox?: boolean):
      ThreadMetadataUpdate {
    // Intentionally don't delete due date if we're leaving it in the inbox.
    let update: ThreadMetadataUpdate = {
      needsRetriage: firebase.firestore.FieldValue.delete(),
      blocked: firebase.firestore.FieldValue.delete(),
      muted: firebase.firestore.FieldValue.delete(),
      archivedByFilter: firebase.firestore.FieldValue.delete(),
      finalVersion: firebase.firestore.FieldValue.delete(),
      queued: firebase.firestore.FieldValue.delete(),
      // Intentionally keep only the labelId and not the hasLabel so we can
      // show what label a thread came from even after it's been triaged.
      // hasLabel the latter is for deciding whether to show the thread in
      // the TriageModel.
      hasLabel: firebase.firestore.FieldValue.delete(),
      hasPriority: firebase.firestore.FieldValue.delete(),
      priorityId: firebase.firestore.FieldValue.delete(),
    }

    if (removeFromInbox) {
      update.moveToInbox = firebase.firestore.FieldValue.delete();
      update.due = firebase.firestore.FieldValue.delete();
      update.labelId = firebase.firestore.FieldValue.delete();
    }
    return update;
  }

  static async clearMetadata(threadId: string) {
    let update = this.clearedMetadata_(true);
    await Thread.metadataCollection().doc(threadId).update(update);
  }

  static metadataCollection() {
    return firestoreUserCollection().doc('threads').collection('metadata');
  }

  setActionInProgress(inProgress: boolean) {
    this.actionInProgress_ = inProgress;
    this.actionInProgressTimestamp_ = inProgress ? Date.now() : undefined;
  }

  actionInProgress() {
    return !!this.actionInProgress_;
  }

  actionInProgressTimestamp() {
    return this.actionInProgressTimestamp_;
  }

  removeFromInboxMetadata_() {
    let update = Thread.clearedMetadata_(true);
    update.countToArchive = this.messageCount_();
    return update;
  }

  archiveUpdate(archivedByFilter?: boolean) {
    // TODO: Take into account the repeat pattern. This assumes daily.
    if (this.hasRepeat())
      return this.stuckDaysUpdate(1);

    let update = this.removeFromInboxMetadata_();
    if (archivedByFilter)
      update.archivedByFilter = true;
    return update;
  }

  async archive(archivedByFilter?: boolean) {
    await this.updateMetadata(this.archiveUpdate(archivedByFilter));
  }

  muteUpdate() {
    if (this.hasRepeat()) {
      alert('Cannot mute a repeating item.');
      return;
    }

    let update = this.removeFromInboxMetadata_();
    update.muted = true;
    return update;
  }

  async mute() {
    let update = this.muteUpdate();
    if (!update)
      return;
    await this.updateMetadata(update);
  }

  keepInInboxMetadata_() {
    let update = Thread.clearedMetadata_();
    // Mark the last time this thread was triaged so we don't retriage it too
    // soon after that.
    update.retriageTimestamp = Date.now();
    return update;
  }

  isUnread() {
    // Old threads don't have a readCount since we added that field later.
    return this.metadata_.readCount !== undefined &&
        this.metadata_.readCount < this.metadata_.messageIds.length;
  }

  async markRead() {
    // Old threads don't have a readCount since we added that field later.
    if (this.metadata_.readCount === undefined ||
        this.metadata_.readCount < this.metadata_.messageIds.length) {
      let messageCount = this.messageCount_();
      await this.updateMetadata(
          {readCount: messageCount, countToMarkRead: messageCount});
    }
  }

  priorityUpdate(priority: Priority, moveToInbox?: boolean) {
    let update = this.keepInInboxMetadata_();
    if (moveToInbox)
      update.moveToInbox = true;
    update.hasPriority = true;
    update.priorityId = priority;
    return update;
  }

  clearStuckUpdate(moveToInbox?: boolean) {
    let update = this.clearDate_(ThreadMetadataKeys.blocked, moveToInbox);
    // Clearing blocked should put the thread back in the triage queue,
    // otherwise the thread just disappears. If the user wants a queue other
    // than triage, they can just use that action directly instead of clearing
    // blocked (e.g. set the priority).
    update.hasLabel = true;
    return update;
  }

  clearDueUpdate(moveToInbox?: boolean) {
    return this.clearDate_(ThreadMetadataKeys.due, moveToInbox);
  }

  private clearDate_(key: ThreadMetadataKeys, moveToInbox?: boolean) {
    let update: ThreadMetadataUpdate = {};
    if (moveToInbox)
      update.moveToInbox = true;
    update[key] = firebase.firestore.FieldValue.delete();
    return update;
  }

  stuckUpdate(date: Date, moveToInbox?: boolean) {
    return this.setDate(ThreadMetadataKeys.blocked, date, moveToInbox);
  }

  stuckDaysUpdate(days: number, moveToInbox?: boolean) {
    return this.setDateDays_(ThreadMetadataKeys.blocked, days, moveToInbox);
  }

  dueUpdate(date: Date, moveToInbox?: boolean) {
    return this.setDate(ThreadMetadataKeys.due, date, moveToInbox, true);
  }

  dueDaysUpdate(days: number, moveToInbox?: boolean) {
    return this.setDateDays_(ThreadMetadataKeys.due, days, moveToInbox, true);
  }

  setDate(
      key: ThreadMetadataKeys, date: Date, moveToInbox?: boolean,
      keepMetadata?: boolean) {
    // Don't want setting the due date to reset retriageTimestamp or reset
    // other fields.
    let update = keepMetadata ? {} : this.keepInInboxMetadata_();

    if (moveToInbox)
      update.moveToInbox = true;

    // Setting a new due date resets the bit that prevents the thread from being
    // marked overdue.
    if (key === ThreadMetadataKeys.due)
      update.dueDateExpired = firebase.firestore.FieldValue.delete();

    update[key] = date.getTime();
    return update;
  }

  setDateDays_(
      key: ThreadMetadataKeys, days: number, moveToInbox?: boolean,
      keepMetadata?: boolean) {
    let date = new Date();
    // Set the time to midnight to ensure consistency since we only care about
    // day boundaries.
    date.setHours(0, 0, 0);
    date.setDate(date.getDate() + days);

    return this.setDate(key, date, moveToInbox, keepMetadata);
  }

  async setOnlyFinalVersion(value: boolean) {
    await this.updateMetadata({finalVersion: value});
  }

  async setOnlyLabel(label: string) {
    await this.updateMetadata({labelId: await this.queueNames_.getId(label)});
  }

  repeatUpdate() {
    let current = this.metadata_.repeat;
    let newRepeat;
    if (current) {
      newRepeat = firebase.firestore.FieldValue.delete();
    } else {
      newRepeat = {type: RepeatType.Daily};
    }
    return {repeat: newRepeat} as ThreadMetadataUpdate;
  }

  finalVersion() {
    return !!this.metadata_.finalVersion;
  }

  hasRepeat() {
    return !!this.metadata_.repeat;
  }

  hasDueDate() {
    return !!this.metadata_.due;
  }

  isBlocked() {
    return !!this.metadata_.blocked;
  }

  needsRetriage() {
    return !!this.metadata_.needsRetriage;
  }

  getDate() {
    return new Date(defined(this.metadata_.timestamp));
  }

  getLastTriagedDate() {
    // Fallback to the timestamp of the last message in the thread if for some
    // reason we don't have a retriageTimestamp (e.g. threads that are triaged
    // before we added retriageTimestamps to them).
    return new Date(
        this.metadata_.retriageTimestamp || defined(this.metadata_.timestamp));
  }

  getBlockedDate() {
    if (!this.isBlocked())
      return null;

    let blocked = defined(this.metadata_.blocked);
    // TODO: Remove this once blocked can no longer be a boolean.
    if (blocked === true) {
      let today = new Date();
      today.setDate(today.getDate() + 1);
      return today;
    }
    if (blocked === false)
      assert(false);
    return new Date(blocked as number);
  }

  getDueDate() {
    if (!this.hasDueDate())
      return null;
    let due = defined(this.metadata_.due);
    return new Date(due as number);
  }

  getSubject() {
    return this.processed_.getSubject();
  }

  getMessageIds() {
    return this.metadata_.messageIds;
  }

  getCountToArchive() {
    return this.metadata_.countToArchive;
  }

  getMessages() {
    return this.processed_.messages;
  }

  isQueued() {
    return !!this.metadata_.queued;
  }

  getLabelId() {
    return this.metadata_.labelId;
  }

  getLabel() {
    let id = this.getLabelId();
    if (!id)
      return FALLBACK_LABEL_NAME;

    switch (id) {
      case BuiltInLabelIds.Blocked:
        return BLOCKED_LABEL_NAME;
      case BuiltInLabelIds.Fallback:
        return FALLBACK_LABEL_NAME;
      default:
        let name = this.queueNames_.getName(id);
        return name || FALLBACK_LABEL_NAME;
    }
  }

  needsTriage() {
    // TODO: Rename hasLabel to needsTriage in firestore.
    return this.metadata_.hasLabel;
  }

  getPriorityId() {
    return this.metadata_.priorityId;
  }

  getPriority() {
    switch (this.getPriorityId()) {
      case Priority.Pin:
        return PINNED_PRIORITY_NAME;
      case Priority.NeedsFilter:
        return NEEDS_FILTER_PRIORITY_NAME;
      case Priority.MustDo:
        return MUST_DO_PRIORITY_NAME;
      case Priority.Urgent:
        return URGENT_PRIORITY_NAME;
      case Priority.Backlog:
        return BACKLOG_PRIORITY_NAME;
    }
    return null;
  }

  getHistoryId() {
    return this.metadata_.historyId;
  }

  isMuted() {
    return this.metadata_.muted;
  }

  getFrom() {
    return this.processed_.getFrom();
  }

  getSnippet() {
    return this.processed_.getSnippet();
  }

  private getRawMessages_() {
    return this.processed_.messages.map(x => x.rawMessage);
  }

  getMetadataDocument_() {
    return Thread.metadataCollection().doc(this.id);
  }

  static async fetchMetadata(id: string) {
    let doc = Thread.metadataCollection().doc(id);
    let snapshot = await doc.get();
    if (snapshot.exists) {
      return snapshot.data() as ThreadMetadata;
    }

    let data = {
      historyId: '',
      messageIds: [],
      timestamp: 0,
      readCount: 0,
    } as ThreadMetadata;
    await doc.set(data);
    return data;
  }

  async setLabelAndQueued(
      shouldQueue: boolean, label: string, hasLabel: boolean) {
    let update: ThreadMetadataUpdate = {
      queued: shouldQueue,
      labelId: await this.queueNames_.getId(label),
      hasLabel: hasLabel,
    };

    // If we're not putting the item into the triage queue, then we should leave
    // it's blocked state untouched as it is the case where the user sent
    // themself a new message and then immediately marked it blocked.
    if (hasLabel)
      update.blocked = firebase.firestore.FieldValue.delete();
    await this.updateMetadata(update);
  }

  getData() {
    return this.metadata_;
  }

  async update() {
    // If we don't have any messages yet, it's more efficient to fetch the full
    // thread from the network and fetching the indivudal messages.
    if (!this.processed_.messages.length) {
      let data = await this.fetchFromNetwork_();
      let historyId = defined(data.historyId);
      let messages = defined(data.messages);
      await this.saveMessageState_(historyId, messages);
      return;
    }

    let processedMessages = defined(this.processed_).messages;

    let resp = await gapiFetch(gapi.client.gmail.users.threads.get, {
      userId: USER_ID,
      id: this.id,
      format: 'minimal',
      fields: 'historyId,messages(id,labelIds,internalDate)',
    });

    let historyId = defined(resp.result.historyId);
    let messages = defined(resp.result.messages);

    // If the historyId both on disk and in firestore matches what gmail
    // returns, then there's no work to do. In theory, what's in firestore
    // should match what's on disk if what's on disk matches gmail, but due to
    // races with different clients, it's possible for an older client's write
    // to override a newer client's write.
    if (defined(this.processed_).historyId === historyId &&
        this.getHistoryId() === historyId)
      return;

    // TODO: Need to refetch drafts that were sent. Make the loop below fetch
    // the message if the messageId has changed.
    for (let i = 0; i < processedMessages.length; i++) {
      let labels = messages[i].labelIds || [];
      processedMessages[i].updateLabels(labels);
    }

    let allRawMessages = this.getRawMessages_();
    // Fetch the full message details for any new messages.
    // TODO: If there are many messages to fetch, might be faster to just
    // refetch the whole thread or maybe do a BatchRequest for all the messages.
    for (let i = allRawMessages.length; i < messages.length; i++) {
      let resp = await gapiFetch(gapi.client.gmail.users.messages.get, {
        userId: USER_ID,
        id: messages[i].id,
      });
      allRawMessages.push(resp.result);
    }

    await this.saveMessageState_(historyId, allRawMessages);
  }

  private static getTimestamp_(message: gapi.client.gmail.Message) {
    let date = Number(defined(message.internalDate));
    return new Date(date).getTime();
  }

  async generateMetadataFromGmailState_(
      historyId: string, messages: gapi.client.gmail.Message[]) {
    let lastMessage = messages[messages.length - 1];

    let newMetadata: ThreadMetadata = {
      historyId: historyId,
      messageIds: messages.flatMap(x => defined(x.id)),
      timestamp: Thread.getTimestamp_(lastMessage),
    };

    this.sentMessageIds_ =
        this.sentMessageIds_.filter(x => !newMetadata.messageIds.includes(x));

    await this.updateMetadata(newMetadata);

    // Ensure metadata is correct after the update. An alternative would be to
    // have an onsnapshot listener, but those are expensive to setup for every
    // thread. Alternately, should updateMetadata just do this? Then we'd never
    // have metadata_ be out of date, but it would come at the cost of an extra
    // network fetch for each updateMetadata call.
    this.metadata_ = await Thread.fetchMetadata(this.id);

    // This is technically only needed in the case where updateMetadata didn't
    // update anything. This happens when firestore is up to date, but the
    // messages on local disk are stale.
    this.dispatchEvent(new UpdatedEvent());
  }

  async fetchFromDisk() {
    if (this.processed_.messages.length)
      return;

    let data = await this.deserializeMessageData_();
    if (!data)
      return;
    let messages = defined(data.messages);
    this.processed_.process(data.historyId, messages);
    this.dispatchEvent(new UpdatedEvent());
  }

  // If the metadata in firestore doesn't match the one in local
  // storage, pull in the new messages and labels so we're up to date.
  async syncMessagesInFirestore() {
    if (this.getHistoryId() != this.processed_.historyId)
      await this.update();
  }

  private async fetchFromNetwork_() {
    if (!this.fetchPromise_) {
      this.fetchPromise_ = gapiFetch(gapi.client.gmail.users.threads.get, {
        userId: USER_ID,
        id: this.id,
      })
    }
    let resp = await this.fetchPromise_;
    this.fetchPromise_ = null;
    return resp.result;
  }

  async saveMessageState_(
      historyId: string, messages: gapi.client.gmail.Message[]) {
    this.processed_.process(historyId, messages);
    await this.generateMetadataFromGmailState_(historyId, messages);
    await this.serializeMessageData_(historyId, messages);
  }

  // Ensure there's only one Thread per id so that we can use reference
  // equality.
  static create(id: string, metadata: ThreadMetadata) {
    let entry = memoryCache_.get(id);
    if (entry) {
      entry.metadata_ = metadata;
    } else {
      entry = new Thread(id, metadata);
      memoryCache_.set(id, entry);
    }
    return entry;
  }

  private getKey_(weekNumber: number, threadId: string) {
    return `thread-${weekNumber}-${threadId}`;
  }

  private async deserializeMessageData_(): Promise<SerializedMessages|null> {
    let currentWeekKey = this.getKey_(getCurrentWeekNumber(), this.id);
    let localData = await IDBKeyVal.getDefault().get(currentWeekKey);

    let oldKey;
    if (!localData) {
      oldKey = this.getKey_(getPreviousWeekNumber(), this.id);
      localData = await IDBKeyVal.getDefault().get(oldKey);
    }

    if (!localData)
      return null;

    if (oldKey) {
      await IDBKeyVal.getDefault().del(oldKey);
      await IDBKeyVal.getDefault().set(currentWeekKey, localData);
    }

    return JSON.parse(localData);
  }

  private async serializeMessageData_(
      historyId: string, messages: gapi.client.gmail.Message[]) {
    let key = this.getKey_(getCurrentWeekNumber(), this.id);
    try {
      await IDBKeyVal.getDefault().set(key, JSON.stringify({
        messages: messages,
        historyId: historyId,
      }));
    } catch (e) {
      console.log('Fail storing message details in IDB.', e);
    }
  }

  async sendReply(
      replyText: string, extraEmails: ParsedAddress[], replyType: ReplyType,
      sender: gapi.client.gmail.SendAs) {
    let messages = this.getMessages();
    let lastMessage = messages[messages.length - 1];

    let to = [];
    if (replyType === ReplyType.Forward) {
      assert(
          extraEmails.length,
          'Add recipients by typing +email in the reply box.')
    } else {
      // Gmail will remove dupes for us if the to and from fields have
      // overlap.
      let from = lastMessage.replyTo || lastMessage.from;
      if (from)
        to.push(...parseAddressList(from));

      if (replyType === ReplyType.ReplyAll && lastMessage.to) {
        let excludeMe =
            lastMessage.parsedTo.filter(x => x.address !== sender.sendAsEmail);
        to.push(...excludeMe);
      }
    }

    if (extraEmails.length)
      to.push(...extraEmails);

    let subject = lastMessage.subject || '';
    let replyPrefix = replyType === ReplyType.Forward ? 'Fwd: ' : 'Re: ';
    if (subject && !subject.startsWith(replyPrefix))
      subject = replyPrefix + subject;

    let headers = `In-Reply-To: ${lastMessage.messageId}\n`;
    if (replyType === ReplyType.ReplyAll && lastMessage.cc)
      headers += `Cc: ${lastMessage.cc}\n`;

    let text;
    if (replyType === ReplyType.Forward) {
      let from = lastMessage.from ? `From: ${lastMessage.from}<br>` : '';
      let date = lastMessage.from ?
          `Date: ${FWD_THREAD_DATE_FORMATTER.format(lastMessage.date)}<br>` :
          '';
      let subject =
          lastMessage.from ? `Subject: ${lastMessage.subject}<br>` : '';
      let to = lastMessage.from ? `To: ${lastMessage.to}<br>` : '';
      text = `${replyText}<br><br>---------- Forwarded message ---------<br>${
          from}${date}${subject}${to}<br>${lastMessage.getHtmlOrPlain()}`;
    } else {
      text = `${replyText}<br><br>${lastMessage.from} wrote:<br>
  <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid var(--border-color);padding-left:1ex">
    ${lastMessage.getHtmlOrPlain()}
  </blockquote>`;
    }

    let message = await send(text, to, subject, sender, headers, this.id);
    // If the message is in this same thread, then account for it appropriately
    // in the message counts. This can happen even if it's a forward, e.g. if
    // you forward to yourself.
    if (message.threadId === this.id)
      this.sentMessageIds_.push(defined(message.id));
  }
}
