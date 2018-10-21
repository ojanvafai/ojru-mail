class Timer extends HTMLElement {
  constructor(autoStart, timeout, overlayContainer) {
    super();

    this.style.cssText = `
      display: block;
      font-size: 32px;
      padding: 4px;
    `;

    // Never autostart the timer on the first thread.
    if (Timer.autoStart_ === undefined) {
      Timer.autoStart_ = autoStart;
      this.paused_ = true;
    } else {
      this.paused_ = !Timer.autoStart_;
    }

    this.timeout_ = timeout;
    this.overlayContainer_ = overlayContainer;

    this.timeDisplay_ = document.createElement('span');
    this.timeDisplay_.style.cssText = `
      border-radius: 5px;
    `;

    this.timerButton_ = document.createElement('span');
    this.append(this.timeDisplay_, '\xa0', this.timerButton_);

    this.updatePlayButton_();
    this.timerButton_.onclick = () => this.toggleTimer_();
  }

  connectedCallback() {
    Timer.activeTimers_.push(this);
    if (Timer.autoStart_)
      this.restartTimer_();
  }

  disconnectedCallback() {
    Timer.activeTimers_ = Timer.activeTimers_.filter(item => item != this);
    this.clearTimer_();
    this.clearOverlay_();
  }

  visibilityChanged(isHidden) {
    if (!isHidden) {
      this.restartTimer_();
      return;
    }

    this.timeLeft_ = -1;
    this.clearTimer_();
  }

  clearTimer_() {
    if (this.timerKey_) {
      clearTimeout(this.timerKey_);
      this.timerKey_ = null;
    }
  }

  toggleTimer_() {
    this.paused_ = !this.paused_;
    if (this.paused_)
      Timer.autoStart_ = false;
    this.updatePlayButton_();
    this.clearOverlay_();
    this.restartTimer_();
  }

  updatePlayButton_() {
    this.timerButton_.textContent = this.paused_ ? '▶️' : '⏸️';
  }

  restartTimer_() {
    if (this.overlay_)
      return;

    if (this.paused_) {
      this.timeDisplay_.textContent = '';
      return;
    }

    this.timeLeft_ = this.timeout_;
    this.clearTimer_();
    this.nextTick_();
  }

  clearOverlay_() {
    if (this.overlay_) {
      this.overlay_.remove();
      this.overlay_ = null;
    }
  }

  async nextTick_() {
    if (this.paused_ || this.timeLeft_ == -1) {
      this.timeDisplay_.textContent = '';
      return;
    }

    if (this.timeLeft_ == 0) {
      this.timeDisplay_.textContent = '';
      this.overlay_ = document.createElement('div');
      this.overlay_.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      `;
      let background = document.createElement('div');
      background.style.cssText = `
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        background-color: black;
        opacity: 0.5;
      `;
      let text = document.createElement('div');
      text.innerHTML = 'Out of time. Take an action!<br><br>The timer duration and whether it autostarts can be configured in the settings dialogs.';
      text.style.cssText = `
        position: absolute;
        padding: 5px;
        background-color: white;
      `;
      this.overlay_.append(background, text);
      this.overlayContainer_.append(this.overlay_);
      return;
    }

    if (this.timeLeft_ > 20) {
      this.timeDisplay_.style.color = 'white';
    } else if (this.timeLeft_ > 5) {
      this.timeDisplay_.style.color = 'black';
    } else {
      this.timeDisplay_.style.color = 'red';
    }

    this.timeDisplay_.textContent = this.timeLeft_;
    this.timerKey_ = setTimeout(this.nextTick_.bind(this), 1000);
    this.timeLeft_--;
  }
}

Timer.activeTimers_ = [];

window.customElements.define('mt-timer', Timer);

document.addEventListener('visibilitychange', (e) => {
  for (let timer of Timer.activeTimers_) {
    timer.visibilityChanged(document.visibilityState == 'hidden');
  }
});
