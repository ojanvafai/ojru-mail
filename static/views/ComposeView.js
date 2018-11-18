import { Compose } from '../Compose.js';

const AUTO_SAVE_KEY = 'ComposeView-auto-save-key';
const SEND = { name: 'Send', description: 'Ummm...send the mail.' };
const ACTIONS = [ SEND ];
const PRE_FILL_URL = '/compose?to=email@address.com&subject=This is my subject&body=This is the email itself';
const HELP_TEXT = `Hints:

Put ## followed by a priority level in your email to automatically route your message to a that make-time priority. Valid priorities are ##must-do, ##urgent, ##not-urgent, ##delegate.

URL to prefill fields: <a href='${PRE_FILL_URL}'>${PRE_FILL_URL}</a>.
`;

let idbKeyVal_;
async function idbKeyVal() {
  let IDBKeyVal = (await import('../idb-keyval.js')).IDBKeyVal;
  if (!idbKeyVal_)
    idbKeyVal_ = IDBKeyVal.getDefault();
  return idbKeyVal_;
}

export class ComposeView extends HTMLElement {
  constructor(contacts, updateTitle, params) {
    super();

    this.updateTitle_ = updateTitle;
    this.params_ = params || {};

    this.to_ = this.createInput_();
    this.appendLine_('To:\xa0', this.to_);

    this.subject_ = this.createInput_();
    this.appendLine_('Subject:\xa0', this.subject_);

    this.body_ = new Compose(contacts, true);
    this.body_.style.cssText = `
      flex: 1;
      margin: 4px;
      display: flex;
      background-color: white;
      min-height: 200px;
    `;

    this.prefill_();

    this.body_.addEventListener('email-added', this.handleUpdates_.bind(this));
    this.body_.addEventListener('input', this.debounceHandleUpdates_.bind(this));

    let help = document.createElement('div');
    help.style.cssText = `white-space: pre-wrap;`;
    help.innerHTML = HELP_TEXT;
    this.append(this.body_, help);
  }

  async prefill_() {
    let localData = await (await idbKeyVal()).get(AUTO_SAVE_KEY);
    if (!localData)
      localData = this.params_;

    if (localData.to)
      this.to_.value = localData.to;
    if (localData.inlineTo)
      this.getInlineTo_().textContent = localData.inlineTo;
    if (localData.subject)
      this.subject_.value = localData.subject;
    if (localData.body)
      this.body_.value = localData.body;

    this.focusFirstEmpty_();
  }

  createInput_() {
    let input = document.createElement('input');
    input.addEventListener('input', this.debounceHandleUpdates_.bind(this));
    input.style.cssText = `
      border: 1px solid;
      flex: 1;
      outline: none;
    `;
    return input;
  }

  appendLine_(...children) {
    let line = this.createLine_(...children);
    this.append(line);
  }

  createLine_(...children) {
    let line = document.createElement('div');
    line.style.cssText = `
      display: flex;
      margin: 4px;
    `;
    line.append(...children);
    return line;
  }

  inlineToText_() {
    if (!this.inlineTo_)
      return '';
    return this.inlineTo_.textContent;
  }

  getInlineTo_() {
    if (!this.inlineTo_) {
      this.inlineTo_ = document.createElement('div');
      let line = this.createLine_('Inline to:\xa0', this.inlineTo_);
      this.to_.parentNode.after(line);
    }
    return this.inlineTo_;
  }

  debounceHandleUpdates_() {
    requestIdleCallback(this.handleUpdates_.bind(this));
  }

  async handleUpdates_() {
    let emails = this.body_.getEmails();
    if (emails.length)
      this.getInlineTo_().textContent = emails.join(', ');

    let data = {};
    let hasData = false;
    if (this.to_.value) {
      data.to = this.to_.value;
      hasData = true;
    }
    if (this.inlineTo_) {
      data.inlineTo = this.inlineToText_();
      hasData = true;
    }
    if (this.subject_.value) {
      data.subject = this.subject_.value;
      hasData = true;
    }
    if (this.body_.value) {
      data.body = this.body_.value;
      hasData = true;
    }

    if (hasData)
      await (await idbKeyVal()).set(AUTO_SAVE_KEY, data);
    else
     await (await idbKeyVal()).del(AUTO_SAVE_KEY);
  }

  focusFirstEmpty_() {
    if (!this.to_.value) {
      this.to_.focus();
      return;
    }

    if (!this.subject_.value) {
      this.subject_.focus();
      return;
    }

    this.body_.focus();
  }

  connectedCallback() {
    let footer = document.getElementById('footer');
    footer.textContent = '';

    for (let action of ACTIONS) {
      let button = document.createElement('button');
      button.tooltip = action.description;

      button.onclick = () => this.takeAction_(action);
      button.onmouseenter = () => {
        button.tooltipElement = document.createElement('div');
        button.tooltipElement.style.cssText = `
          position: absolute;
          bottom: ${footer.offsetHeight}px;
          left: 0;
          right: 0;
          display: flex;
          justify-content: center;
        `;

        let text = document.createElement('div');
        text.style.cssText = `
          background-color: white;
          border: 1px solid;
          padding: 4px;
          width: 300px;
        `;

        text.append(button.tooltip);
        button.tooltipElement.append(text);
        footer.append(button.tooltipElement);
      }
      button.onmouseleave = () => {
        button.tooltipElement.remove();
      }
      let name = action.name;
      button.textContent = name;
      footer.append(button);
    }
  }

  async takeAction_(action) {
    if (action != SEND)
      throw `Invalid action: ${JSON.stringify(action)}`;

    if (this.sending_)
      return;
    this.sending_ = true;

    this.updateTitle_('sending', 'Sending...');
    let mail = await import('../Mail.js');

    let to = '';
    if (this.to_.value)
      to += this.to_.value + ',';
    if (this.inlineTo_)
      to += this.inlineToText_() + ',';

    await mail.send(this.body_.value, to, this.subject_.value);
    await (await idbKeyVal()).del(AUTO_SAVE_KEY);
    this.updateTitle_('sending');

    this.to_.value = '' || this.params_.to;
    if (this.inlineTo_)
      this.getInlineTo_().textContent = '';
    this.subject_.value = '' || this.params_.subject;
    this.body_.value = '' || this.params_.body;

    this.sending_ = false;
  }

  tearDown() {
  }
}

window.customElements.define('mt-compose-view', ComposeView);
