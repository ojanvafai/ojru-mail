import { assert, isMobileUserAgent, linkify, notNull, sandboxedDom } from '../Base.js';
import { RenderedThread } from '../RenderedThread.js';
import { ALL, NONE, SelectBox, SelectChangedEvent, SOME } from '../SelectBox.js';
import { InProgressChangedEvent, Priority, Thread, UpdatedEvent } from '../Thread.js';

import { SelectRowEvent, ThreadRowGroupRenderMode } from './ThreadRowGroup.js';
import { ThreadRowGroupBase } from './ThreadRowGroupBase.js';
import { LabelSelect, LabelSelectedEvent } from '../LabelSelect.js';

let DIFFERENT_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

let DIFFERENT_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

let SAME_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: 'numeric',
});

let formattingOptions: {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
} = {
  month: 'short',
  day: 'numeric',
};

let DAY_MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, formattingOptions);

export class FocusRowEvent extends Event {
  static NAME = 'focus-row';
  constructor() {
    super(FocusRowEvent.NAME, { bubbles: true });
  }
}

export class AfterFocusRowEvent extends Event {
  static NAME = 'after-focus-row';
  constructor() {
    super(AfterFocusRowEvent.NAME, { bubbles: true });
  }
}

export class RenderThreadEvent extends Event {
  static NAME = 'render-thread';
  constructor(public shiftKey: boolean) {
    super(RenderThreadEvent.NAME, { bubbles: true });
  }
}

export class LabelState {
  public label: string | null;
  public priority: string | null;
  public blocked: Date | null;
  public hasRepeat: boolean;

  constructor(thread: Thread, public group: string) {
    this.label = thread.getLabel();
    this.priority = thread.getPriority();
    this.blocked = thread.getStuckDate();
    this.hasRepeat = thread.hasRepeat();
  }

  equals(other: LabelState) {
    return (
      this.group === other.group &&
      this.label === other.label &&
      this.priority === other.priority &&
      this.datesEqual_(this.blocked, other.blocked) &&
      this.hasRepeat === other.hasRepeat
    );
  }

  private datesEqual_(a: Date | null, b: Date | null) {
    if (a && b) return a.getTime() === b.getTime();
    return a === b;
  }
}

class RowState extends LabelState {
  isSmallScreen: boolean;
  subject: string;
  snippet: string;
  from: HTMLElement;
  isUnread: boolean;
  renderPinnedStyle: boolean;
  count?: number;
  lastMessageId?: string;

  constructor(thread: Thread, group: string, public shouldHide: boolean) {
    super(thread, group);

    // window.innerWidth makes more logical sense for this, but chrome has
    // bugs. crbug.com/960803.
    this.isSmallScreen = window.outerWidth < 600;

    this.subject = thread.getSubject();
    this.snippet = thread.getSnippet();
    this.from = thread.getFrom();
    this.isUnread = thread.isUnread();
    this.renderPinnedStyle = thread.getPriorityId() === Priority.Pin;

    let messageIds = thread.getMessageIds();
    if (messageIds) {
      this.count = messageIds.length;
      this.lastMessageId = messageIds[messageIds.length - 1];
    }
  }

  equals(other: RowState): boolean {
    return (
      super.equals(other) &&
      this.isSmallScreen === other.isSmallScreen &&
      this.subject === other.subject &&
      this.snippet === other.snippet &&
      // TODO: Change this to use pointer equality.
      // getFrom() clones a new copy, so use innerHTML instead of pointer
      // equality.
      this.from.innerHTML === other.from.innerHTML &&
      this.count === other.count &&
      this.lastMessageId === other.lastMessageId &&
      this.isUnread === other.isUnread &&
      this.renderPinnedStyle === other.renderPinnedStyle &&
      this.shouldHide === other.shouldHide
    );
  }
}

export class ThreadRow extends HTMLElement {
  rendered: RenderedThread;
  mark: boolean | undefined;
  private inViewport_: boolean;
  private focused_: boolean;
  private focusImpliesSelected_: boolean;
  private checkBox_: SelectBox;
  private messageDetails_: HTMLElement;
  private lastRowState_?: RowState;
  private mode_?: ThreadRowGroupRenderMode;
  private static lastHeightIsSmallScreen_: boolean;
  private static lastHeight_: number;

  constructor(public thread: Thread) {
    super();

    this.style.cssText = `
      display: flex;
      white-space: nowrap;
      padding-right: 12px;
      align-items: center;
    `;
    this.inViewport_ = false;
    this.focused_ = false;
    this.focusImpliesSelected_ = true;

    this.checkBox_ = new SelectBox();
    this.append(this.checkBox_);

    this.checkBox_.addEventListener(SelectChangedEvent.NAME, (e) => {
      let rangeSelect = (e as SelectChangedEvent).rangeSelect;
      this.handleCheckedChanged_(rangeSelect);
      this.setFocus(true, false);
    });

    this.messageDetails_ = document.createElement('div');
    this.messageDetails_.style.cssText = `
      overflow: hidden;
      flex: 1;
      min-height: 40px;
      display: flex;
    `;
    this.messageDetails_.addEventListener('click', (e) => {
      // If the user is selecting the subject line in the row, have that prevent
      // rendering the thread so they can copy-paste the subject. If the click
      // is inside a link, prevent the threadrow action since the link click
      // will open a new tab and we don't want to do both.
      if (!this.threadRowContainsSelection_() && !(e.target as Element).closest('a'))
        this.dispatchEvent(new RenderThreadEvent(e.shiftKey));
    });
    this.append(this.messageDetails_);

    this.addEventListener('pointerover', () => {
      this.setHovered_(true);
    });
    this.addEventListener('pointerout', () => {
      this.setHovered_(false);
    });

    this.rendered = new RenderedThread(thread);
    thread.addEventListener(UpdatedEvent.NAME, () => this.handleThreadUpdated_());

    // Redispatch this so the ThreadListView picks it up.
    thread.addEventListener(InProgressChangedEvent.NAME, () => {
      // This happens when a triage action completes on a Thread, which means
      // that the row was removed from the view, so we should remove it's
      // previous focused/checked state.
      this.resetState_();
      // The threadrow isn't in the DOM when the action completes since we
      // removed it when the thread actionInProgress was set to true. Need to
      // think about how to notify the ThreadListView that an update has
      // happened.
      this.dispatchEvent(new InProgressChangedEvent());
    });

    this.updateCheckbox_();
  }

  static lastHeight() {
    return this.lastHeight_;
  }

  setInViewport(inViewport: boolean) {
    // Don't rerender if inViewport state isn't changing.
    if (this.inViewport_ === inViewport) return;
    this.inViewport_ = inViewport;
    this.render();
  }

  private threadRowContainsSelection_() {
    let sel = notNull(window.getSelection());
    return (
      !sel.isCollapsed && (this.containsNode_(sel.anchorNode) || this.containsNode_(sel.focusNode))
    );
  }

  private containsNode_(node: Node | null) {
    if (!node) return false;

    while (node.parentNode) {
      if (node.parentNode == this) return true;
      node = node.parentNode;
    }
    return false;
  }

  private resetState_() {
    // Intentionally use the public setters so that styles are updated.
    this.clearFocus();
    this.setChecked(false);
  }

  getGroupMaybeNull() {
    let parent = this.parentElement;
    while (parent && !(parent instanceof ThreadRowGroupBase)) {
      parent = parent.parentElement;
    }
    return parent;
  }

  getGroup() {
    let parent = this.getGroupMaybeNull();
    return assert(parent, 'Attempted to get the parent group of a ThreadRow not in a group.');
  }

  private handleThreadUpdated_() {
    this.render();
    if (this.rendered.isAttached()) {
      // Rerender messages even if the thread is only prerendred in case new
      // messages came in.
      this.rendered.render();
    }
  }

  connectedCallback() {
    this.render();
  }

  render() {
    if (!this.inViewport_) return;

    let group = this.getGroupMaybeNull();
    if (!group) return;

    let shouldHide =
      this.mode_ === ThreadRowGroupRenderMode.ShowOnlyHighlightedRows && !this.highlighted;
    let state = new RowState(this.thread, group.name, shouldHide);

    // Keep track of the last state we used to render this row so we can avoid
    // rendering new frames when nothing has changed.
    if (this.lastRowState_ && this.lastRowState_.equals(state)) return;

    this.lastRowState_ = state;
    this.style.display = state.shouldHide ? 'none' : 'flex';
    if (state.shouldHide) {
      return;
    }

    let labels = document.createElement('div');
    labels.className = 'mr1';
    if (state.renderPinnedStyle) {
      let pinned = document.createElement('span');
      pinned.title = 'Pinned';
      pinned.append('📌');
      labels.append(pinned);
    }
    ThreadRow.appendLabels(labels, state, this.thread);

    let justSubject = document.createElement('span');
    justSubject.append(state.subject);
    linkify(justSubject);

    let subject = document.createElement('span');
    subject.className = 'contains-pii';
    subject.style.cssText = `
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      display: flex;
      align-items: center;
    `;

    const renderMultiline = state.isSmallScreen && !state.renderPinnedStyle;
    if (!renderMultiline && !state.renderPinnedStyle) subject.style.marginRight = '25px';

    subject.style.fontSize = isMobileUserAgent() ? '16px' : '14px';

    subject.append(justSubject);

    if (state.snippet) {
      let snippet = sandboxedDom(`- ${state.snippet}`);
      snippet.style.cssText = `
        margin-left: 4px;
        color: var(--dim-text-color);
      `;
      subject.append(snippet);
    }

    let date = document.createElement('div');
    if (!state.renderPinnedStyle) {
      this.appendDate_(date);
    }
    let boldState = state.isUnread ? '600' : '';
    justSubject.style.fontWeight = boldState;
    date.style.fontWeight = boldState;

    this.messageDetails_.textContent = '';
    this.messageDetails_.style.flexDirection = renderMultiline ? 'column' : '';

    let fromContainer = document.createElement('div');
    fromContainer.className = 'contains-pii';
    if (!state.renderPinnedStyle) {
      this.appendFromContainer_(fromContainer, state);
    }
    if (renderMultiline) {
      this.messageDetails_.style.padding = '12px 0 12px 4px';
      this.messageDetails_.style.alignItems = '';
      let topRow = document.createElement('div');
      topRow.style.cssText = `
        display: flex;
        align-items: center;
        margin-bottom: 4px;
      `;
      topRow.append(fromContainer, labels, date);
      this.messageDetails_.append(topRow, subject);

      fromContainer.style.flex = '1';
    } else {
      this.messageDetails_.style.padding = '0 0 0 4px';
      this.messageDetails_.style.alignItems = 'center';
      this.messageDetails_.append(fromContainer, labels, subject, date);
    }

    // All rows are the same height, so we can save the last rendered height in
    // a static variable that we can then use to estimate heights for the
    // virtual scrolling. The height of rows only changes if the screen width
    // changes or if the user zooms. We don't currently handle the latter.
    // TODO: Handle pinned cards being a different height.
    // TODO: Make the in progress change card the same size and pinned.
    if (state.isSmallScreen !== ThreadRow.lastHeightIsSmallScreen_) {
      ThreadRow.lastHeightIsSmallScreen_ = state.isSmallScreen;
      ThreadRow.lastHeight_ = this.offsetHeight;
    }
  }

  private appendFromContainer_(fromContainer: HTMLElement, state: RowState) {
    fromContainer.style.cssText = `
      width: 150px;
      display: flex;
      align-items: baseline;
    `;

    let from = document.createElement('div');
    from.style.cssText = `
      overflow: hidden;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--dim-text-color);
    `;
    from.append(state.from);
    fromContainer.append(from);

    if (state.count && state.count > 1) {
      let count = document.createElement('div');
      count.style.cssText = `
        font-size: 80%;
        margin: 0 6px;
        color: var(--dim-text-color);
      `;
      count.textContent = String(state.count);
      fromContainer.append(count);
    }
  }

  private appendDate_(dateContainer: HTMLElement) {
    dateContainer.textContent = this.dateString_(this.thread.getDate());
    dateContainer.style.cssText = `
      text-align: right;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--dim-text-color);
      display: flex;
      align-items: center;
    `;
  }

  static appendLabels(container: HTMLElement, state: LabelState, thread: Thread) {
    // TODO: Make this a date picker for changing the blocked date.
    if (state.blocked) {
      let blockedString = `Stuck: ${DAY_MONTH_FORMATTER.format(state.blocked)}`;
      let label = this.createLabel_(blockedString);
      container.append(label);
    }

    // TODO: Make this a select element for changing the priority.
    if (state.priority && state.group !== state.priority) {
      let label = this.createLabel_(state.priority);
      container.append(label);
    }

    if (state.label && state.group !== state.label) {
      let label = new LabelSelect(state.label);
      // Clicks on the select shouldn't also be clicks on the row.
      label.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      label.addEventListener(LabelSelectedEvent.NAME, (e: Event) => {
        thread.setOnlyLabel((e as LabelSelectedEvent).name);
      });
      container.append(label);
    }

    if (state.hasRepeat) {
      let repeat = document.createElement('span');
      repeat.textContent = '\u{1F501}';
      repeat.style.marginLeft = '4px';
      container.append(repeat);
    }
  }

  private static createLabel_(text: string) {
    let label = document.createElement('span');
    this.styleLabel_(label);

    label.append(text);
    return label;
  }

  private static styleLabel_(label: HTMLElement) {
    label.className = 'label-chip';
    label.style.cssText = `
      display: inline-block;
      font-size: 0.75rem;
      line-height: 18px;
      margin-right: 4px;
      white-space: nowrap;
    `;
  }

  private dateString_(date: Date) {
    let formatter: Intl.DateTimeFormat;
    let today = new Date();
    if (today.getFullYear() != date.getFullYear()) {
      formatter = DIFFERENT_YEAR_FORMATTER;
    } else if (today.getMonth() != date.getMonth() || today.getDate() != date.getDate()) {
      formatter = DIFFERENT_DAY_FORMATTER;
    } else {
      formatter = SAME_DAY_FORMATTER;
    }
    return formatter.format(date);
  }

  setRenderMode(mode: ThreadRowGroupRenderMode) {
    this.mode_ = mode;
    this.render();
  }

  setFocus(value: boolean, focusImpliesSelected: boolean) {
    this.focusImpliesSelected_ = focusImpliesSelected;
    this.focused_ = value;
    this.checkBox_.style.backgroundColor = this.focused_ ? 'var(--border-and-hover-color)' : '';
    this.updateCheckbox_();
    // TODO: Technically we probably want a blur event as well for !value.
    if (value) {
      this.dispatchEvent(new FocusRowEvent());
      this.dispatchEvent(new AfterFocusRowEvent());
    }
    this.render();
  }

  clearFocus() {
    this.setFocus(false, true);
  }

  clearFocusImpliesSelected() {
    this.setFocus(this.focused_, false);
  }

  get focused() {
    return this.focused_;
  }

  get highlighted() {
    return this.focused_ || this.checked;
  }

  get selected() {
    return this.checked || (this.focused_ && this.focusImpliesSelected_);
  }

  get checked() {
    return this.checkBox_.isFullySelected();
  }

  setCheckedAndFocus(value: boolean) {
    this.setFocus(value, true);
    this.setChecked(value);
  }

  setChecked(value: boolean, rangeSelect?: boolean) {
    this.checkBox_.select(value ? ALL : NONE);
    this.updateCheckbox_();
    this.handleCheckedChanged_(rangeSelect);
  }

  private handleCheckedChanged_(rangeSelect?: boolean) {
    this.dispatchEvent(new SelectRowEvent(this.checked, !!rangeSelect));
    this.render();
  }

  private setHovered_(hovered: boolean) {
    this.checkBox_.setHovered(hovered);
  }

  private updateCheckbox_() {
    let newState;
    if (this.checked) newState = ALL;
    else if (this.focused_ && this.focusImpliesSelected_) newState = SOME;
    else newState = NONE;

    this.checkBox_.select(newState);
  }
}

window.customElements.define('mt-thread-row', ThreadRow);
