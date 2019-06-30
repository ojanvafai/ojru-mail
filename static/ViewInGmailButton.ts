import {defined, isMobileUserAgent} from './Base.js';

export class ViewInGmailButton extends HTMLElement {
  messageId_: string|undefined;

  constructor() {
    super();

    if (isMobileUserAgent())
      return;

    this.append('↗');

    this.style.cssText = `
      display: flex;
      border: 1px solid;
      width: 0.9em;
      height: 0.9em;
      align-items: center;
      justify-content: center;
      padding: 3px;
      margin: 1px;
      font-size: 12px;
    `;

    this.onclick = (e) => {
      window.open(
          `https://mail.google.com/mail/#all/${defined(this.messageId_)}`);
      e.preventDefault();
      e.stopPropagation();
    };
  }

  setMessageId(messageId: string) {
    // In theory, linking to the threadId should work, but it doesn't for some
    // threads. Linking to the messageId seems to work reliably. The message ID
    // listed will be expanded in the gmail UI, so link to the last one since
    // that one is definitionally always expanded.
    this.messageId_ = messageId;
  }
}

window.customElements.define('mt-view-in-gmail-button', ViewInGmailButton);
