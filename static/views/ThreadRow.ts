import {assert} from '../Base.js';
import {RenderedThread} from '../RenderedThread.js';
import {Thread, UpdatedEvent} from '../Thread.js';
import {ViewInGmailButton} from '../ViewInGmailButton.js';

import {ThreadRowGroup} from './ThreadRowGroup.js';

let UNCHECKED_BACKGROUND_COLOR = '#ffffffbb';

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
}

let DAY_MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, formattingOptions);

export class FocusRowEvent extends Event {
  static NAME = 'focus-row';
  constructor() {
    super(FocusRowEvent.NAME, {bubbles: true});
  }
}

export class SelectRowEvent extends Event {
  static NAME = 'select-row';
  constructor(public shiftKey: boolean) {
    super(SelectRowEvent.NAME, {bubbles: true});
  }
}

export class RenderThreadEvent extends Event {
  static NAME = 'render-thread';
  constructor(public shiftKey: boolean) {
    super(RenderThreadEvent.NAME, {bubbles: true});
  }
}

export class HeightChangedEvent extends Event {
  static NAME = 'row-height-changed';
  constructor() {
    super(HeightChangedEvent.NAME, {bubbles: true});
  }
}

export class LabelState {
  public label: string|null;
  public priority: string|null;
  public blocked: Date|null;
  public due: Date|null;
  public hasRepeat: boolean;

  constructor(thread: Thread, public group: string) {
    this.label = thread.getLabel();
    this.priority = thread.getPriority();
    this.blocked = thread.getBlockedDate();
    this.due = thread.getDueDate();
    this.hasRepeat = thread.hasRepeat();
  }

  equals(other: LabelState) {
    return this.group === other.group && this.label === other.label &&
        this.priority === other.priority &&
        this.datesEqual_(this.blocked, other.blocked) &&
        this.datesEqual_(this.due, other.due) &&
        this.hasRepeat === other.hasRepeat;
  }

  datesEqual_(a: Date|null, b: Date|null) {
    if (a && b)
      return a.getTime() === b.getTime();
    return a === b;
  }
}

class RowState extends LabelState {
  isSmallScreen: boolean;
  subject: string;
  snippet: string;
  from: HTMLElement;
  isUnread: boolean;
  actionInProgress: boolean;
  count: number;
  lastMessageId: string;

  constructor(
      thread: Thread, public group: string,
      public finalVersionSkipped: boolean) {
    super(thread, group);

    // window.innerWidth makes more logical sense for this, but chrome has
    // bugs. crbug.com/960803.
    this.isSmallScreen = window.outerWidth < 600;

    this.subject = thread.getSubject();
    this.snippet = thread.getSnippet();
    this.from = thread.getFrom();
    this.isUnread = thread.isUnread();
    this.actionInProgress = thread.actionInProgress();

    let messageIds = thread.getMessageIds();
    this.count = messageIds.length;
    this.lastMessageId = messageIds[messageIds.length - 1];
  }

  equals(other: RowState): boolean {
    return super.equals(other) && this.isSmallScreen === other.isSmallScreen &&
        this.subject === other.subject && this.snippet === other.snippet &&
        this.from === other.from && this.count === other.count &&
        this.lastMessageId === other.lastMessageId &&
        this.isUnread === other.isUnread &&
        this.finalVersionSkipped === other.finalVersionSkipped &&
        this.actionInProgress === other.actionInProgress;
  }
}

export class ThreadRow extends HTMLElement {
  private inViewport_: boolean;
  private focused_: boolean;
  private checked_: boolean;
  private focusImpliesSelected_: boolean;
  rendered: RenderedThread;
  mark: boolean|undefined;
  private checkBox_: HTMLInputElement;
  private label_: HTMLElement;
  private messageDetails_: HTMLElement;
  private lastRowState_?: RowState;
  private finalVersionSkipped_: boolean;
  private static lastHeightIsSmallScreen_: boolean;
  private static lastHeight_: number;

  constructor(
      public thread: Thread, private showFinalVersion_: boolean,
      private labelSelectTemplate_: HTMLSelectElement) {
    super();
    this.style.cssText = `
      display: flex;
      background-color: ${UNCHECKED_BACKGROUND_COLOR};
    `;

    this.inViewport_ = false;
    this.focused_ = false;
    this.checked_ = false;
    this.focusImpliesSelected_ = false;
    this.finalVersionSkipped_ = false;

    if (showFinalVersion_) {
      let container = this.appendCheckboxContainer_();
      let checkbox = this.appendCheckbox_(container);
      checkbox.checked = thread.finalVersion();
      container.addEventListener('click', async () => {
        await this.thread.setOnlyFinalVersion(checkbox.checked);
      });
    }

    this.label_ = this.appendCheckboxContainer_();
    this.checkBox_ = this.appendCheckbox_(this.label_);

    // Pevent the default behavior of text selection on shift+click this is
    // used for range selections. Need to do it on mousedown unfortunately
    // since that's when the selection is modified on some platforms (e.g.
    // mac).
    this.label_.addEventListener('mousedown', e => {
      if (e.shiftKey)
        e.preventDefault();
    });
    this.label_.addEventListener('click', e => this.select(e.shiftKey));

    // This pointer-events:none is so that clicking on the checkbox doesn't do
    // anything since we toggle the checked state ourselves. For some reason
    // e.preventDefault() on click doesn't seem to achieve the same result,
    // but couldn't actually reduce it to a small test case to file a bug.
    this.checkBox_.style.pointerEvents = 'none';
    this.append(this.label_);

    this.messageDetails_ = document.createElement('div');
    this.messageDetails_.style.cssText = `
      display: flex;
      overflow: hidden;
      flex: 1;
    `;

    // Pevent the default behavior of text selection on shift+click this is
    // used for range selections. Need to do it on mousedown unfortunately
    // since that's when the selection is modified on some platforms (e.g.
    // mac). Need to do this on messageDetails_ in additon to the label since
    // the whole row is clickable in Skim view.
    // TODO: See if we need this now that we no longer have Skim view. Should
    // we make the whole row clickable when viewing messages is disallowed in
    // Triage view?
    this.messageDetails_.addEventListener('mousedown', e => {
      if (e.shiftKey)
        e.preventDefault();
    });

    this.messageDetails_.addEventListener('click', (e) => {
      // If the user is selecting the subject line in the row, have that
      // prevent rendering the thread so they can copy-paste the subject.
      if (!this.threadRowContainsSelection_())
        this.dispatchEvent(new RenderThreadEvent(e.shiftKey));
    });
    this.append(this.messageDetails_);

    this.rendered = new RenderedThread(thread);
    thread.addEventListener(
        UpdatedEvent.NAME, () => this.handleThreadUpdated_());
  }

  static lastHeight() {
    return this.lastHeight_;
  }

  setInViewport(inViewport: boolean) {
    // Don't rerender if inViewport state isn't changing.
    if (this.inViewport_ === inViewport)
      return;
    this.inViewport_ = inViewport;
    this.render();
  }

  private appendCheckboxContainer_() {
    let container = document.createElement('div');
    container.style.cssText = `
      width: 40px;
      border-right: 0;
      display: flex;
      justify-content: center;
      align-items: center;
    `;
    this.append(container);
    return container;
  }

  private appendCheckbox_(container: HTMLElement) {
    let checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cssText = `
      margin-left: 5px;
      margin-right: 5px;
    `;

    container.append(checkbox);
    return checkbox;
  }

  select(shiftKey: boolean) {
    this.checked = !this.selected;
    if (this.checked)
      this.dispatchEvent(new SelectRowEvent(shiftKey));
    this.setFocus(true, false);
  }

  threadRowContainsSelection_() {
    let sel = window.getSelection();
    return !sel.isCollapsed &&
        (this.containsNode_(sel.anchorNode) ||
         this.containsNode_(sel.focusNode));
  }

  containsNode_(node: Node) {
    while (node.parentNode) {
      if (node.parentNode == this)
        return true;
      node = node.parentNode;
    }
    return false;
  }

  resetState() {
    // Intentionally use the public setters so that styles are updated.
    this.clearFocus();
    this.checked = false;
  }

  getGroup() {
    let parent = this.parentElement;
    while (parent && !(parent instanceof ThreadRowGroup)) {
      parent = parent.parentElement
    }
    return assert(
        parent,
        'Attempted to get the parent group of a ThreadRow not in a group.');
  }

  private handleThreadUpdated_() {
    this.render();
    if (this.rendered.isAttached()) {
      // Rerender messages even if the thread is only prerendred in case new
      // messages came in.
      this.rendered.render();
      // If the thread is the actual rendered thread, mark new messages as
      // read.
      if (this.rendered.isRendered())
        this.thread.markRead();
    }
  }

  connectedCallback() {
    this.render();
  }

  setFinalVersionSkipped(value: boolean) {
    this.finalVersionSkipped_ = value;
    this.render();
  }

  render() {
    if (!this.parentNode || !this.inViewport_)
      return;

    let state = new RowState(
        this.thread, this.getGroup().name,
        this.showFinalVersion_ && this.finalVersionSkipped_);

    // Keep track of the last state we used to render this row so we can avoid
    // rendering new frames when nothing has changed.
    if (this.lastRowState_ && this.lastRowState_.equals(state))
      return;

    this.lastRowState_ = state;

    this.style.opacity = state.actionInProgress ? '0.2' : '';
    this.style.display = state.finalVersionSkipped ? 'none' : 'flex';

    let fromContainer = document.createElement('div');
    fromContainer.style.cssText = `
      width: 150px;
      margin-right: 25px;
      padding-left: 5px;
      display: flex;
      align-items: baseline;
    `;

    let from = document.createElement('div');
    from.style.cssText = `
      overflow: hidden;
    `;
    from.append(state.from)

    let count = document.createElement('div');
    count.style.cssText = `
      font-size: 80%;
      margin-left: 4px;
      color: grey;
    `;

    if (state.count > 1)
      count.textContent = String(state.count);
    fromContainer.append(from, count);

    let title = document.createElement('div');
    title.style.cssText = `
      overflow: hidden;
      margin-right: 25px;
      flex: 1;
    `;
    ThreadRow.appendLabels(
        title, state, this.thread, this.labelSelectTemplate_);

    let snippet = document.createElement('span');
    snippet.style.color = '#666';
    // Snippet as returned by the gmail API is html escaped.
    snippet.innerHTML = ` - ${state.snippet}`;

    let subject = document.createElement('span');
    subject.append(state.subject || '\xa0');
    title.append(subject, snippet);

    let date = document.createElement('div');
    date.textContent = this.dateString_(this.thread.getDate());
    date.style.cssText = `
      width: 4.5em;
      text-align: right;
    `;

    let boldState = state.isUnread ? '600' : '';
    subject.style.fontWeight = boldState;
    date.style.fontWeight = boldState;

    let popoutButton = new ViewInGmailButton();
    popoutButton.setMessageId(state.lastMessageId);
    popoutButton.style.marginLeft = '4px';
    popoutButton.style.marginRight = '4px';

    this.messageDetails_.textContent = '';
    this.messageDetails_.style.flexDirection =
        state.isSmallScreen ? 'column' : '';

    if (state.isSmallScreen) {
      this.messageDetails_.style.alignItems = '';

      let topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.append(fromContainer);
      topRow.append(date, popoutButton);
      this.messageDetails_.append(topRow, title);

      fromContainer.style.flex = '1';
      title.style.fontSize = '12px';
      title.style.margin = '5px 5px 0 5px';
    } else {
      this.messageDetails_.style.alignItems = 'center';
      this.messageDetails_.append(fromContainer, title);
      this.messageDetails_.append(date, popoutButton);
    }

    // All rows are the same height, so we can save the last rendered height in
    // a static variable that we can then use to estimate heights for the
    // virtual scrolling. The height of rows only changes if the screen width
    // changes or if the user zooms. We don't currently handle the latter.
    if (state.isSmallScreen !== ThreadRow.lastHeightIsSmallScreen_) {
      ThreadRow.lastHeightIsSmallScreen_ = state.isSmallScreen;
      ThreadRow.lastHeight_ = this.offsetHeight;
    }
  }

  static appendLabels(
      container: HTMLElement, state: LabelState, thread: Thread,
      labelSelect: HTMLSelectElement) {
    // TODO: Make this a date picker for changing the blocked date.
    if (state.blocked) {
      let blockedString = `Stuck: ${DAY_MONTH_FORMATTER.format(state.blocked)}`;
      let label = this.createLabel_(blockedString);
      container.append(label);
    }

    // TODO: Make this a date picker for changing the due date.
    if (state.due) {
      let blockedString = `Due: ${DAY_MONTH_FORMATTER.format(state.due)}`;
      let label = this.createLabel_(blockedString);
      if (state.due < new Date())
        label.style.color = 'red';
      container.append(label);
    }

    // TODO: Make this a select element for changing the priority.
    if (state.priority && state.group !== state.priority) {
      let label = this.createLabel_(state.priority);
      container.append(label);
    }

    if (state.label && state.group !== state.label) {
      let label = this.createSelectChip_(state.label);

      // Clicks on the select shouldn't also be clicks on the row.
      label.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      label.addEventListener('pointerdown', () => {
        label.style.color = '#666';
        label.style.backgroundColor = '#ddd';

        if (label.children.length > 1)
          return;

        let cloned = labelSelect.cloneNode(true) as HTMLSelectElement;
        label.append(...cloned.children);

        (label.children[0] as HTMLOptionElement).selected = true;
      });

      // Remove the extra items so the select shrinks back down to the width
      // of the currently selected one.
      let removeUnselected = () => {
        let toRemove = Array.from(label.children) as HTMLOptionElement[];
        for (let element of toRemove) {
          if (!element.selected)
            element.remove();
        }
      };

      label.addEventListener('blur', () => removeUnselected());

      label.addEventListener('change', async () => {
        let newLabel = label.selectedOptions[0].value;
        removeUnselected();
        await thread.setOnlyLabel(newLabel);
      });

      container.append(label);
    }

    if (state.hasRepeat) {
      let repeat = document.createElement('span')
      repeat.textContent = '\u{1F501}';
      repeat.style.marginRight = '4px';
      container.append(repeat);
    }
  }

  private static createSelectChip_(text: string) {
    let label = document.createElement('select');
    // TODO: Share some code with createLabel_.
    label.style.cssText = `
      display: inline-block;
      color: #666;
      background-color: #ddd;
      font-size: 0.75rem;
      line-height: 18px;
      border: none;
      border-radius: 4px;
      padding: 0 4px;
      margin-right: 4px;
    `;
    label.addEventListener('pointerenter', () => {
      label.style.color = '#ddd';
      label.style.backgroundColor = '#666';
    });
    label.addEventListener('pointerleave', () => {
      label.style.color = '#666';
      label.style.backgroundColor = '#ddd';
    });
    let option = new Option();
    option.append(text);
    label.append(option);
    return label;
  }

  private static createLabel_(text: string) {
    let label = document.createElement('span');
    label.style.cssText = `
      display: inline-block;
      color: #666;
      background-color: #ddd;
      font-size: 0.75rem;
      line-height: 18px;
      border-radius: 4px;
      padding: 0 4px;
      margin-right: 4px;
      white-space: nowrap;
    `;
    label.append(text);
    return label;
  }

  private dateString_(date: Date) {
    let formatter: Intl.DateTimeFormat;
    let today = new Date();
    if (today.getFullYear() != date.getFullYear()) {
      formatter = DIFFERENT_YEAR_FORMATTER;
    } else if (
        today.getMonth() != date.getMonth() ||
        today.getDate() != date.getDate()) {
      formatter = DIFFERENT_DAY_FORMATTER;
    } else {
      formatter = SAME_DAY_FORMATTER;
    }
    return formatter.format(date);
  }

  setFocus(value: boolean, focusImpliesSelected: boolean) {
    this.focusImpliesSelected_ = focusImpliesSelected;
    this.focused_ = value;
    this.label_.style.backgroundColor = this.focused_ ? '#ccc' : '';
    this.updateCheckbox_();
    // TODO: Technically we probably want a blur event as well for !value.
    if (value)
      this.dispatchEvent(new FocusRowEvent());
  }

  clearFocus() {
    this.setFocus(false, false);
  }

  clearFocusImpliesSelected() {
    this.setFocus(this.focused_, false);
  }

  get selected() {
    return this.checked_ || (this.focused_ && this.focusImpliesSelected_);
  }

  get checked() {
    return this.checked_;
  }

  set checked(value) {
    this.checked_ = value;
    this.style.backgroundColor =
        this.checked_ ? '#c2dbff' : UNCHECKED_BACKGROUND_COLOR;
    this.updateCheckbox_();
  }

  updateCheckbox_() {
    this.checkBox_.checked = this.selected;
  }
}

window.customElements.define('mt-thread-row', ThreadRow);
