/* Touch presentation only. Inject inside main(), after gameplay modules and before startup. */
(() => {
  const touchDevice = window.CORNY_APPLE_TOUCH === true ||
    (navigator.maxTouchPoints > 0 && window.matchMedia?.('(pointer: coarse)').matches) ||
    /iPhone|iPad|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!touchDevice) return;

  const root = document.documentElement;
  const hud = $('hud');
  root.classList.add('apple-touch');
  const stick = document.createElement('div');
  stick.id = 'appleStick';
  stick.setAttribute('role', 'group');
  stick.setAttribute('aria-label', 'Movement joystick. Drag in the direction you want to move.');
  const thumb = document.createElement('span');
  thumb.className = 'appleStickThumb';
  const stickLabel = document.createElement('span');
  stickLabel.className = 'appleStickLabel';
  stickLabel.textContent = 'MOVE';
  stick.append(thumb, stickLabel);
  const lookHint = document.createElement('div');
  lookHint.id = 'appleLookHint';
  lookHint.textContent = 'DRAG TO LOOK';
  lookHint.setAttribute('aria-hidden', 'true');
  hud.append(stick, lookHint);
  $('heldItem').setAttribute('aria-label', 'Open inventory and equipment');
  $('jump').setAttribute('title', 'Jump, hold to swim up, or exit your vehicle');
  $('dive').setAttribute('title', 'Hold to swim down');

  let stickPointer = null;
  const stickMoves = new Set();
  const heldButtons = new Map();
  const keyboardMoves = new Map();
  const managedMoves = ['forward', 'backward', 'left', 'right', 'rise', 'dive'];
  const touchClickUntil = new Map();
  function syncMovement() {
    for (const direction of managedMoves) {
      const on = stickMoves.has(direction) || [...heldButtons.values()].some(v => v.direction === direction) ||
        [...keyboardMoves.values()].includes(direction);
      if (on && mode === 'playing') held.add(direction);
      else held.delete(direction);
    }
  }
  function releaseCapture(element, pointerId) {
    if (pointerId === null || pointerId === undefined) return;
    try { if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId); } catch {}
  }
  function resetStick() {
    const pointer = stickPointer;
    stickPointer = null;
    stickMoves.clear();
    stick.classList.remove('pressed');
    thumb.style.transform = 'translate(0px, 0px)';
    releaseCapture(stick, pointer);
    syncMovement();
  }
  function resetTouch() {
    keyboardMoves.clear();
    const buttons = [...heldButtons.entries()];
    heldButtons.clear();
    for (const [pointer, state] of buttons) {
      state.button.classList.remove('pressed');
      releaseCapture(state.button, pointer);
    }
    resetStick();
    releaseCapture(canvas, lookPointer);
    lookPointer = null;
    hud.classList.remove('apple-touch-playing');
  }
  function updateStick(event) {
    const bounds = stick.getBoundingClientRect();
    const radius = bounds.width * .33;
    let x = event.clientX - bounds.left - bounds.width / 2;
    let y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(x, y);
    if (distance > radius) { x *= radius / distance; y *= radius / distance; }
    thumb.style.transform = `translate(${x}px, ${y}px)`;
    stickMoves.clear();
    // Eight directions retain the game's existing walking, boat and tank speeds.
    if (distance > bounds.width * .09) {
      const length = Math.hypot(x, y);
      if (x / length > .3827) stickMoves.add('right');
      if (x / length < -.3827) stickMoves.add('left');
      if (y / length > .3827) stickMoves.add('backward');
      if (y / length < -.3827) stickMoves.add('forward');
    }
    syncMovement();
  }
  stick.addEventListener('pointerdown', event => {
    if (mode !== 'playing' || stickPointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    stickPointer = event.pointerId;
    stick.classList.add('pressed');
    stick.setPointerCapture(event.pointerId);
    updateStick(event);
  });
  stick.addEventListener('pointermove', event => {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    if (mode !== 'playing') resetStick();
    else updateStick(event);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(type, event => { if (event.pointerId === stickPointer) resetStick(); });
  }

  // Jump happens on the press, while rise/dive remain held independently of the joystick and camera.
  for (const [id, direction] of [['jump', 'rise'], ['dive', 'dive']]) {
    const button = $(id);
    button.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode !== 'playing') return;
      touchClickUntil.set(id, performance.now() + 700);
      heldButtons.set(event.pointerId, {button, direction});
      button.classList.add('pressed');
      button.setPointerCapture(event.pointerId);
      syncMovement();
      if (id === 'jump') jump();
    }, true);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, event => {
        if (event.pointerType === 'mouse') return;
        const state = heldButtons.get(event.pointerId);
        if (!state || state.button !== button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        touchClickUntil.set(id, performance.now() + 700);
        heldButtons.delete(event.pointerId);
        if (![...heldButtons.values()].some(v => v.button === button)) button.classList.remove('pressed');
        releaseCapture(button, event.pointerId);
        syncMovement();
      }, true);
    }
    button.addEventListener('click', event => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen' || performance.now() < (touchClickUntil.get(id) || 0)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  // Existing canvas touch-look handles a second finger and keeps tap-to-interact behavior.
  canvas.addEventListener('lostpointercapture', event => {
    if (event.pointerId === lookPointer) lookPointer = null;
  });
  window.addEventListener('keydown', event => {
    if (mode !== 'playing' || event.target instanceof HTMLInputElement || event.target?.isContentEditable || event.target?.tagName === 'TEXTAREA') return;
    const direction = event.code === 'Space' ? 'rise' : moveKeys[event.code];
    if (direction) { keyboardMoves.set(event.code, direction); syncMovement(); }
  });
  window.addEventListener('keyup', event => { keyboardMoves.delete(event.code); syncMovement(); });

  const previousReleaseControls = releaseControls;
  releaseControls = function (...args) { resetTouch(); return previousReleaseControls(...args); };
  const previousRenderHUD = renderHUD;
  renderHUD = function (...args) {
    const result = previousRenderHUD(...args);
    if (!netActing) {
      hud.classList.toggle('apple-touch-playing', mode === 'playing');
      if (mode !== 'playing' && (stickPointer !== null || heldButtons.size)) resetTouch();
    }
    return result;
  };
  const previousEnterPlay = enterPlay;
  enterPlay = function (...args) {
    const result = previousEnterPlay(...args);
    hud.classList.toggle('apple-touch-playing', mode === 'playing');
    return result;
  };
  // The original resume button stores a function reference rather than calling enterPlay dynamically.
  $('resume').onclick = () => enterPlay();
  function suspendTouchGame() {
    releaseControls();
    stopMining();
    if (mode === 'playing') pauseGame();
    saveCurrent();
  }
  window.addEventListener('corny-app-background', suspendTouchGame);
  window.addEventListener('blur', resetTouch);
  window.addEventListener('pagehide', resetTouch);
  window.addEventListener('orientationchange', () => { releaseControls(); stopMining(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTouch(); });
  // Do not resume automatically after a call, an app switch, or an Apple purchase sheet.
  function updateVisibleViewport() {
    const viewport = window.visualViewport;
    const keyboard = viewport ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
    root.style.setProperty('--apple-keyboard-inset', `${keyboard}px`);
  }
  window.visualViewport?.addEventListener('resize', updateVisibleViewport);
  window.visualViewport?.addEventListener('scroll', updateVisibleViewport);
  updateVisibleViewport();
})();
