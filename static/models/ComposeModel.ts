import {IDBKeyVal} from '../idb-keyval.js';
import {send} from '../Mail.js';

import {Model} from './Model.js';
import { parseAddressList } from '../Base.js';

const AUTO_SAVE_KEY = 'ComposeView-auto-save-key';

export class ComposeModel extends Model {
  private sending_: boolean;
  private to_: string;
  private inlineTo_: string;
  private subject_: string;
  private body_: string;

  constructor() {
    super();

    this.sending_ = false;
    this.to_ = '';
    this.inlineTo_ = '';
    this.subject_ = '';
    this.body_ = '';
  }

  async update() {}

  setTo(value: string) {
    this.to_ = value;
  }

  setInlineTo(value: string) {
    this.inlineTo_ = value;
  }

  setSubject(value: string) {
    this.subject_ = value;
  }

  setBody(value: string) {
    this.body_ = value;
  }

  async loadFromDisk() {
    return await IDBKeyVal.getDefault().get(AUTO_SAVE_KEY);
  }

  async flush() {
    // Intentionally only flush if the body is filled out to try to balance not
    // accidentally sending emails to people because you didn't notice that the
    // to field had old values but also not losing a long email if maketime
    // crashes or something.
    if (!this.body_) {
      await IDBKeyVal.getDefault().del(AUTO_SAVE_KEY);
      return;
    }

    await IDBKeyVal.getDefault().set(AUTO_SAVE_KEY, {
      to: this.to_,
      inlineTo: this.inlineTo_,
      subject: this.subject_,
      body: this.body_,
    });
  }

  hasInvalidAddresses_(value: string) {
    let addresses = parseAddressList(value);
    for (let address of addresses) {
      if (!address.address)
        return true;
      let parts = address.address.split('@');
      if (parts.length !== 2)
        return true;
      if (!parts[1].includes('.'))
        return true;
    }
    return false;
  }

  async send(sanitizedBodyText: string) {
    if (this.hasInvalidAddresses_(this.to_)) {
      alert(`To field has an invalid email address: ${this.to_}`);
      return;
    }

    if (!this.subject_) {
      alert(`Subject is empty.`);
      return;
    }

    let to = '';
    if (this.to_)
      to += this.to_ + ',';
    if (this.inlineTo_)
      to += this.inlineTo_ + ',';

    if (this.sending_)
      return;
    this.sending_ = true;

    let progress = this.updateTitle('ComposeModel.send', 1, 'Sending...');
    await send(this.body_, to, this.subject_);
    await IDBKeyVal.getDefault().del(AUTO_SAVE_KEY);
    progress.incrementProgress();

    this.sending_ = false;

    return {
      to: to, subject: this.subject_, body: sanitizedBodyText,
    }
  }
}
