import {ThreadListModel} from '../models/ThreadListModel.js';
import {SelectBox, SelectChangedEvent} from '../SelectBox.js';
import {ALL, NONE, SOME} from '../SelectBox.js';

import {SelectRowEvent, ThreadRow} from './ThreadRow.js';

export class ToggleCollapsedEvent extends Event {
  static NAME = 'toggle-collapsed';
  constructor() {
    super(ToggleCollapsedEvent.NAME);
  }
}

export class ThreadRowGroup extends HTMLElement {
  private rowContainer_: HTMLElement;
  private placeholder_: HTMLElement;
  private selectBox_: SelectBox;
  private groupNameContainer_: HTMLElement;
  private rowCountDisplay_: Text;
  private expander_: HTMLElement;
  private lastRowHeight_?: number;
  private wasCollapsed_?: boolean;

  constructor(
      private groupName_: string, private model_: ThreadListModel,
      private allowedCount_?: number) {
    super();
    // Use negative margin and width to make is so that the rounded corners are
    // clipped when filling the width of the window.
    this.style.cssText = `
      display: block;
      margin-top: 24px;
      border-radius: 3px;
      background-color: var(--nested-background-color);
    `;

    this.selectBox_ = new SelectBox();
    this.selectBox_.addEventListener(SelectChangedEvent.NAME, () => {
      this.selectRows_(this.selectBox_.selected() === ALL);
    });

    this.groupNameContainer_ = document.createElement('div');
    this.groupNameContainer_.style.cssText = `
      font-weight: bold;
      font-size: 18px;
      padding: 12px 4px;
      display: flex;
      border-radius: 3px;
    `;
    this.groupNameContainer_.className = 'outline-on-hover';
    this.groupNameContainer_.addEventListener(
        'click', () => this.toggleCollapsed_());

    this.rowCountDisplay_ = new Text();

    this.expander_ = document.createElement('div');
    this.expander_.style.cssText = `
      color: grey;
      margin: 2px 4px;
      padding: 0 3px;
      font-weight: bold;
      font-size: 12px;
    `;

    this.groupNameContainer_.append(
        groupName_, this.rowCountDisplay_, this.expander_);

    let header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: stretch;
    `;
    header.append(this.selectBox_, this.groupNameContainer_);
    this.append(header);

    this.rowContainer_ = document.createElement('div');
    this.placeholder_ = document.createElement('div');
    this.placeholder_.style.backgroundColor = 'var(--nested-background-color)';
    this.append(this.rowContainer_, this.placeholder_);

    this.addEventListener(SelectRowEvent.NAME, () => this.updateSelectBox_());
  }

  setInViewport(inViewport: boolean) {
    this.rowContainer_.style.display = inViewport ? '' : 'none';
    this.placeholder_.style.display = inViewport ? 'none' : '';

    let rows = Array.from(this.rowContainer_.children) as ThreadRow[];
    for (let row of rows) {
      row.setInViewport(inViewport);
    }
  }

  private updateSelectBox_() {
    let rows = this.getRows();
    let hasChecked = false;
    let hasUnchecked = false;
    for (let row of rows) {
      if (hasChecked && hasUnchecked)
        break;
      if (!hasChecked)
        hasChecked = row.checked;
      if (!hasUnchecked)
        hasUnchecked = !row.checked;
    }

    let select;
    if (hasChecked && hasUnchecked) {
      select = SOME;
    } else if (hasUnchecked) {
      select = NONE;
    } else {
      select = ALL;
    }

    this.selectBox_.select(select);
  }

  private updateRowCount_(count: number, collapsed: boolean) {
    let overLimit = this.allowedCount_ && count > this.allowedCount_;
    this.groupNameContainer_.style.color = overLimit ? 'red' : '';

    let text;
    if (overLimit)
      text = ` (${count}/${this.allowedCount_})`;
    else if (collapsed)
      text = ` (${count})`;
    else
      text = '';
    this.rowCountDisplay_.textContent = text;
  }

  isCollapsed() {
    return this.model_.isCollapsed(this.groupName_);
  }

  private toggleCollapsed_() {
    this.model_.toggleCollapsed(this.groupName_);
  }

  getRows() {
    return Array.from(this.rowContainer_.childNodes) as ThreadRow[];
  }

  getFirstRow() {
    return this.rowContainer_.firstChild as ThreadRow | null;
  }

  hasRows() {
    return !!this.rowContainer_.childElementCount;
  }

  rowsChanged_(rows: ThreadRow[]) {
    if (rows.length !== this.rowContainer_.childElementCount)
      return true;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] !== this.rowContainer_.children[i])
        return true;
    }
    return false;
  }

  setRows(rows: ThreadRow[]) {
    // Minimize DOM modifications to only the cases where something has changed.
    let rowListChanged = this.rowsChanged_(rows);
    if (rowListChanged || this.lastRowHeight_ !== ThreadRow.lastHeight()) {
      this.lastRowHeight_ = ThreadRow.lastHeight();
      this.placeholder_.style.height = `${rows.length * this.lastRowHeight_}px`;
    }

    let collapsed = this.isCollapsed();

    // Performance optimization to avoid doing a bunch of DOM if the count and
    // sort order of rows didn't change.
    if (!rowListChanged && this.wasCollapsed_ === collapsed)
      return [];

    this.wasCollapsed_ = collapsed;
    this.updateRowCount_(rows.length, collapsed);

    this.expander_.textContent = collapsed ? 'ᐯ' : 'ᐱ';
    this.selectBox_.setDisabled(collapsed);

    if (collapsed) {
      // TODO: Should we retain the rows but display:none rowContainer_
      // instead?
      this.rowContainer_.textContent = '';
      return [];
    }

    let removed = [];
    // Remove rows that no longer exist.
    for (let row of Array.from(this.rowContainer_.children) as ThreadRow[]) {
      if (!rows.includes(row)) {
        row.remove();
        removed.push(row);
      }
    }

    let isGroupInViewport = !!this.rowContainer_.parentNode;

    let previousRow;
    // Ensure the order of rows match the new order, but also try to
    // minimize moving things around in the DOM to minimize style recalc.
    for (let row of rows) {
      if (previousRow ? row.previousSibling !== previousRow :
                        row !== this.rowContainer_.firstChild) {
        if (previousRow)
          previousRow.after(row);
        else
          this.rowContainer_.prepend(row);
      }

      row.setInViewport(isGroupInViewport);
      previousRow = row;
    }

    return removed;
  }

  removeIfEmpty() {
    if (!this.rowContainer_.childElementCount)
      this.remove();
  }

  private selectRows_(select: boolean) {
    if (this.isCollapsed())
      return;

    this.selectBox_.select(select ? ALL : NONE);
    let rows = <NodeListOf<ThreadRow>>this.rowContainer_.childNodes;
    for (let child of rows) {
      child.setChecked(select);
      if (!select)
        child.clearFocusImpliesSelected();
    }

    if (select) {
      let lastRow = rows[rows.length - 1];
      lastRow.setFocus(true, false);
    }
  }

  get name() {
    return this.groupName_;
  }
}
window.customElements.define('mt-thread-row-group', ThreadRowGroup);
