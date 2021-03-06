import { defined, isMobileUserAgent } from './Base.js';
import { Contacts } from './Contacts.js';

export class EntrySelectedEvent extends Event {
  static NAME = 'auto-complete-submit';

  constructor(public entry: AutoCompleteEntry) {
    super(EntrySelectedEvent.NAME);
  }
}

export class AutoCompleteEntry extends HTMLElement {
  name: string;
  address: string;

  constructor() {
    super();
    this.name = '';
    this.address = '';
  }
}
window.customElements.define('mt-auto-complete-entry', AutoCompleteEntry);

export class AutoComplete extends HTMLElement {
  private index_: number;
  private contacts_: Contacts;

  constructor() {
    super();
    // TODO: Fix box shadow to respect whether the menu is above or below.
    this.style.cssText = `
      background-color: var(--overlay-background-color);
      position: fixed;
      border: 1px solid var(--border-and-hover-color);
      box-shadow: 2px -2px 10px 1px var(--border-and-hover-color);
      z-index: 100;
      overflow: hidden;
    `;
    this.index_ = 0;
    // Setup contacts in the constructor so the data is fetched off disk early.
    this.contacts_ = Contacts.getDefault();
  }

  setPosition(x: number, y: number) {
    this.style.top = `${y}px`;

    // The rows don't fit on mobile screens, so make them always fill the width
    // of the screen.
    if (isMobileUserAgent()) {
      this.style.left = `8px`;
      this.style.right = `8px`;
    } else {
      this.style.left = `${x}px`;
    }
  }

  getCandidates(search: string) {
    let results: { name: string; address: string }[] = [];

    if (!search) return results;

    search = search.toLowerCase();

    for (let contact of this.contacts_.getAll()) {
      if (contact.name && contact.name.toLowerCase().includes(search)) {
        for (let address of contact.emails) {
          results.push({ name: contact.name, address: address });
        }
      } else {
        for (let address of contact.emails) {
          if (address.includes(search)) results.push({ name: contact.name, address: address });
        }
      }
    }

    if (results.length) {
      // TODO: Put +foo address after the main ones and prefer things that start
      // with the search text over substring matching.
      if (this.contacts_.getSendCounts()) {
        let counts = defined(this.contacts_.getSendCounts());
        results.sort((a, b) => {
          let aCount = counts.get(a.address) || 0;
          let bCount = counts.get(b.address) || 0;
          return bCount - aCount;
        });
      }
      results = results.splice(0, 4);
    }

    if (results.length < 4) {
      // Include whatever the user is typing in case it's not in their contacts
      // or if the contacts API is down.
      results.push({ name: '', address: search });
    }

    return results;
  }

  render(search: string) {
    if (Contacts.getDefault().getAll().length) this.classList.remove('no-contacts');
    else this.classList.add('no-contacts');

    let candidates = this.getCandidates(search);

    this.textContent = '';
    for (let candidate of candidates) {
      let entry = new AutoCompleteEntry();
      // Prevent clicking on the menu losing cursor position.
      entry.onmousedown = (e) => {
        e.preventDefault();
      };
      entry.onclick = () => {
        this.dispatchEvent(new EntrySelectedEvent(entry));
      };
      entry.style.cssText = `
        display: block;
        padding: 8px;
        white-space: nowrap;
      `;

      if (isMobileUserAgent()) entry.style.fontSize = '150%';

      let text = '';
      if (candidate.name) {
        text += `${candidate.name}: `;
        entry.name = candidate.name;
      }
      text += candidate.address;
      entry.textContent = text;
      entry.address = candidate.address;
      this.append(entry);
    }

    this.selectAutocompleteItem_(0);

    return candidates;
  }

  clear() {
    this.textContent = '';
  }

  selected() {
    return <AutoCompleteEntry>this.children[this.index_];
  }

  adjustIndex(adjustment: number) {
    let newIndex = Math.max(0, Math.min(this.index_ + adjustment, this.children.length - 1));
    this.selectAutocompleteItem_(newIndex);
  }

  selectAutocompleteItem_(index: number) {
    this.index_ = index;
    for (let i = 0; i < this.children.length; i++) {
      let child = <AutoCompleteEntry>this.children[i];
      child.style.backgroundColor =
        i == index ? 'var(--selected-background-color)' : 'var(--overlay-background-color)';
    }
  }
}
window.customElements.define('mt-auto-complete', AutoComplete);
