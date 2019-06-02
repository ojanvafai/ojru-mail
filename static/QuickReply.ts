import {defined} from './Base.js';
import {CancelEvent, EmailCompose, SubmitEvent} from './EmailCompose.js';
import {SendAs} from './SendAs.js';
import {ReplyType, Thread} from './Thread.js';
import {Toast} from './Toast.js';
import {AppShell} from './views/AppShell.js';

export class ReplyCloseEvent extends Event {
  static NAME = 'close';
  constructor() {
    super(ReplyCloseEvent.NAME);
  }
}

export class ShowLastMessageEvent extends Event {
  static NAME = 'show-last-message';
  constructor() {
    super(ShowLastMessageEvent.NAME);
  }
}

export class ReplyScrollEvent extends Event {
  static NAME = 'reply-scroll';
  constructor() {
    super(ReplyScrollEvent.NAME);
  }
}

const LENGTHS = ['Tweet', 'Short story', 'Novella', 'Novel'];

export class QuickReply extends HTMLElement {
  private isSending_?: boolean;
  private compose_: EmailCompose;
  private replyType_: HTMLSelectElement;
  private senders_?: HTMLSelectElement;
  private count_: HTMLElement;

  constructor(public thread: Thread, private sendAs_: SendAs) {
    super();
    this.style.cssText = `
      display: flex;
      flex-direction: column;
      flex-wrap: wrap;
      width: 100%;
    `;

    this.compose_ = this.createCompose_();

    this.replyType_ = document.createElement('select');
    this.replyType_.classList.add('button');
    this.replyType_.innerHTML = `
      <option>${ReplyType.ReplyAll}</option>
      <option>${ReplyType.Reply}</option>
      <option>${ReplyType.Forward}</option>
    `;

    let sendAs = defined(this.sendAs_);
    if (sendAs.senders && sendAs.senders.length > 1) {
      let messages = this.thread.getMessages();
      let lastMessage = messages[messages.length - 1];
      let deliveredTo = lastMessage.deliveredTo;

      this.senders_ = document.createElement('select');
      // Shrink this button if we can't fit the whole toolbar on one row, but
      // don't shrink below 100px;
      this.senders_.style.cssText = `
        flex: 1;
        width: 100px;
        max-width: max-content;
      `;
      this.senders_.classList.add('button');
      for (let sender of sendAs.senders) {
        let option = document.createElement('option');
        let email = defined(sender.sendAsEmail);
        option.value = email;
        option.append(`From: ${email}`);
        if (deliveredTo ? email === deliveredTo : sender.isDefault)
          option.setAttribute('selected', 'true');
        this.senders_.append(option);
      }
    }

    let cancel = document.createElement('button');
    cancel.className = 'mktime-button';
    cancel.textContent = 'cancel';
    cancel.onclick = () => this.dispatchEvent(new ReplyCloseEvent());

    // Group these together so they wrap atomically.
    let controls = document.createElement('div');
    controls.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
    `;
    if (this.senders_)
      controls.append(this.senders_);
    controls.append(this.replyType_, cancel);

    this.count_ = document.createElement('span');
    this.count_.style.marginLeft = '4px';
    controls.append(this.count_);
    this.updateProgress_();

    this.append(this.compose_, controls);
  }

  private createCompose_() {
    let compose = new EmailCompose(true);
    compose.style.cssText = `
      flex: 1;
      margin: 4px;
      display: flex;
      background-color: #ffffffbb;
    `;
    compose.placeholder =
        'Hit <enter> to send, <esc> to cancel. Allowed length is configurable in Settings.';
    compose.addEventListener(
        CancelEvent.NAME, () => this.dispatchEvent(new ReplyCloseEvent()));
    compose.addEventListener(SubmitEvent.NAME, () => this.handleSubmit_());
    compose.addEventListener('input', () => this.updateProgress_());
    return compose;
  }

  private exceedsLengthIndex_() {
    let count = this.compose_.plainText.length;
    if (count < 280)
      return 0;
    if (count < 750)
      return 1;
    if (count < 2500)
      return 2;
    return 3;
  }

  private updateProgress_() {
    let oldIndex = LENGTHS.indexOf(this.count_.textContent.split(': ')[1]);
    let index = this.exceedsLengthIndex_();
    if (oldIndex === index)
      return;

    let message = `Length: ${LENGTHS[index]}`;
    // Don't show the toast when we first open QuickReply and show it whenever
    // the length grows.
    if (index > 0 && oldIndex < index)
      this.append(new Toast(message));
    this.count_.textContent = message;
  }

  private async handleSubmit_() {
    let textLength = this.compose_.plainText.length;
    if (!textLength)
      return;

    if (this.isSending_)
      return;
    this.isSending_ = true;
    let progress = AppShell.updateLoaderTitle(
        'ThreadListView.sendReply', 1, 'Sending reply...');

    let sendAs = defined(this.sendAs_);
    let sender: gapi.client.gmail.SendAs|undefined;
    if (sendAs.senders && sendAs.senders.length) {
      // Even if there's only one sendAs sender, we should use it
      // since it could have a custom reply-to.
      if (sendAs.senders.length == 1) {
        sender = sendAs.senders[0];
      } else {
        let sendAsEmail = defined(this.senders_).selectedOptions[0].value;
        sender =
            defined(sendAs.senders.find(x => x.sendAsEmail == sendAsEmail));
      }
    }

    let type = this.replyType_.selectedOptions[0].value as ReplyType;
    try {
      // TODO: Handle if sending fails in such a way that the user can
      // at least save their message text.
      await this.thread.sendReply(
          this.compose_.value, this.compose_.getEmails(), type,
          defined(sender));
    } finally {
      this.isSending_ = false;
      progress.incrementProgress();
    }

    this.dispatchEvent(new ReplyCloseEvent());
    if (type !== ReplyType.Forward)
      this.dispatchEvent(new ReplyScrollEvent());
  }

  focus() {
    this.compose_.focus();
  }
}
window.customElements.define('mt-quick-reply', QuickReply);
