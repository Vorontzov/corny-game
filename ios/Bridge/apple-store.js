/* The bundled Apple app supplies StoreKit entitlements through a main-frame bridge. */
const APPLE_PACK_PRODUCT = 'com.vorontzov.cornygame.christmaspack';
const appleStoreHandler = window.location?.protocol === 'file:'
  ? window.webkit?.messageHandlers?.cornyStore : null;
const appleStoreActive = typeof appleStoreHandler?.postMessage === 'function';
let appleStoreState = null;
let appleStoreQueue = Promise.resolve();
let appleStoreRefresh = null;
let appleStoreRefreshAgain = false;
const appleRestoreButtons = [];

function appleStoreError(value) {
  const message = typeof value === 'string' ? value : value?.message;
  return new Error(message || 'The App Store could not complete this request. Please try again.');
}

function parseAppleStoreState(value) {
  if (value?.error) throw appleStoreError(value.error);
  if (!value || typeof value.owned !== 'boolean' || typeof value.available !== 'boolean' ||
      !value.bonus || typeof value.bonus.delivered !== 'boolean' ||
      value.bonus.worldID !== null && typeof value.bonus.worldID !== 'string' ||
      value.displayPrice !== null && typeof value.displayPrice !== 'string') {
    throw Error('The App Store returned an incomplete purchase status.');
  }
  if (value.owned && (typeof value.transactionID !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(value.transactionID))) {
    throw Error('The App Store could not verify the purchase.');
  }
  if (value.bonus.worldID !== null && !/^[a-zA-Z0-9_-]{1,120}$/.test(value.bonus.worldID)) {
    throw Error('The saved bonus world could not be verified.');
  }
  if (value.bonus.delivered && !value.bonus.worldID) {
    throw Error('The saved bonus delivery could not be verified.');
  }
  return {
    owned: value.owned,
    transactionID: value.owned ? value.transactionID : null,
    displayPrice: value.displayPrice?.trim() || '',
    available: value.available,
    bonus: {worldID: value.bonus.worldID, delivered: value.bonus.delivered},
    outcome: ['cancelled', 'pending'].includes(value.outcome) ? value.outcome : null
  };
}

function applyAppleStoreState(state) {
  appleStoreState = state;
  winterOwned = state.owned;
  winterProof = state.owned ? {
    order: 'apple-' + state.transactionID,
    world: state.bonus.worldID,
    delivered: state.bonus.delivered
  } : null;
  if (state.owned && winterWantedSkin && skinById(winterWantedSkin).pack) {
    playerProfile.skin = winterWantedSkin;
    winterWantedSkin = null;
    saveProfile();
    renderProfile();
    updateHand();
  } else if (!state.owned) {
    winterWantedSkin = null;
    if (skinById(playerProfile.skin).pack) {
      playerProfile.skin = 'pine';
      saveProfile();
      renderProfile();
      updateHand();
    }
  }
  renderSkinGallery();
  renderWinterShop();
  return state;
}

function requestAppleStore(action, worldID) {
  if (!appleStoreActive) return Promise.reject(Error('Apple purchases are available in the Corny Game app.'));
  const message = {action, productID: APPLE_PACK_PRODUCT};
  if (worldID !== undefined) message.worldID = worldID;
  const next = appleStoreQueue.then(async () => {
    const reply = await appleStoreHandler.postMessage(message);
    return applyAppleStoreState(parseAppleStoreState(reply));
  });
  appleStoreQueue = next.then(() => {}, () => {});
  return next;
}

function renderAppleStore() {
  const ready = Boolean(appleStoreState);
  const available = ready && appleStoreState.available && Boolean(appleStoreState.displayPrice);
  for (const {buy, status} of winterCards) {
    buy.disabled = winterOwned || winterWorking || !available;
    if (winterOwned) buy.textContent = 'PACK OWNED';
    else if (winterWorking) buy.textContent = 'WAITING FOR THE APP STORE…';
    else if (!ready) buy.textContent = 'CHECKING THE APP STORE…';
    else buy.textContent = available ? 'BUY · ' + appleStoreState.displayPrice : 'UNAVAILABLE';
    const terms = buy.parentElement?.querySelector('p.small');
    if (terms) terms.textContent = (available ? appleStoreState.displayPrice + ' · ' : '') +
      'One-time purchase with your Apple Account.';
    let detail;
    if (winterOwned) {
      detail = 'Santa and Gingerbread are ready to wear. ';
      if (winterProof.delivered) detail += 'Your gold blocks and emeralds have been delivered.';
      else if (winterProof.world) detail += 'Reopen your selected solo world to collect the gold blocks and emeralds.';
      else detail += 'Open a solo world to receive 2 gold blocks and 10 emeralds.';
    } else {
      detail = !ready ? 'Checking available purchases…' : available
        ? 'Confirm your purchase in the App Store.'
        : 'This pack is not available in the App Store right now. You can restore an existing purchase.';
    }
    status.textContent = winterMessage || detail;
  }
  for (const button of appleRestoreButtons) button.disabled = winterWorking;
}

function refreshAppleStore(changed = false) {
  if (!appleStoreActive) return Promise.resolve(null);
  if (appleStoreRefresh) {
    appleStoreRefreshAgain ||= changed;
    return appleStoreRefresh;
  }
  appleStoreRefresh = (async () => {
    try {
      const state = await requestAppleStore('status');
      if (!winterWorking) winterMessage = '';
      renderWinterShop();
      if (state.owned) await deliverAppleWinterGift();
      return state;
    } catch (error) {
      winterMessage = appleStoreError(error).message;
      renderWinterShop();
      return null;
    } finally {
      appleStoreRefresh = null;
      if (appleStoreRefreshAgain) {
        appleStoreRefreshAgain = false;
        refreshAppleStore();
      }
    }
  })();
  return appleStoreRefresh;
}

async function runApplePurchase(action) {
  if (!appleStoreActive || winterWorking || action === 'purchase' &&
      (winterOwned || !appleStoreState?.available || !appleStoreState.displayPrice)) return;
  winterWorking = true;
  winterMessage = '';
  renderWinterShop();
  try {
    const state = await requestAppleStore(action);
    if (state.outcome === 'cancelled') winterMessage = 'Purchase cancelled.';
    else if (state.outcome === 'pending') winterMessage = 'Your purchase is awaiting approval. It will unlock after Apple confirms it.';
    else if (state.owned) {
      winterMessage = action === 'restore' ? 'Purchase restored.' : 'Christmas Super-Pack unlocked!';
      await deliverAppleWinterGift();
    } else if (action === 'restore') winterMessage = 'No Christmas Super-Pack purchase was found for this Apple Account.';
    else winterMessage = 'Apple has not confirmed a purchase yet.';
  } catch (error) {
    winterMessage = appleStoreError(error).message;
  } finally {
    winterWorking = false;
    renderWinterShop();
  }
}

async function deliverAppleWinterGift() {
  if (!appleStoreActive || winterDelivering || !winterOwned || !winterNormalWorld() || winterProof?.delivered) return;
  const worldID = current.id;
  const expectedOrder = winterProof.order;
  if (winterProof.world && winterProof.world !== worldID) return;
  winterDelivering = true;
  try {
    if (worldFeatures.winterGiftOrder !== expectedOrder && !winterGiftInventory(inventory)) {
      winterMessage = 'Make room for 2 gold blocks and 10 emeralds, then reopen this solo world to collect them.';
      notify('CHRISTMAS PACK: MAKE ROOM FOR 2 GOLD BLOCKS AND 10 EMERALDS.');
      return;
    }
    const reserved = await requestAppleStore('reserveBonus', worldID);
    if (!reserved.owned || !winterOwned || reserved.bonus.delivered ||
        reserved.bonus.worldID !== worldID || winterProof?.order !== expectedOrder ||
        !winterNormalWorld() || current.id !== worldID) return;
    if (worldFeatures.winterGiftOrder !== expectedOrder) {
      const nextInventory = winterGiftInventory(inventory);
      if (!nextInventory) {
        winterMessage = 'Make room for 2 gold blocks and 10 emeralds, then reopen this solo world.';
        return;
      }
      const previous = {
        inventory, order: worldFeatures.winterGiftOrder,
        state: current.state, updated: current.updated
      };
      try {
        inventory = nextInventory;
        worldFeatures.winterGiftOrder = expectedOrder;
        current.state = capture();
        current.updated = Date.now();
        if (!persist()) throw Error('Your bonus could not be saved. Free some device storage and reopen this world to try again.');
      } catch (error) {
        inventory = previous.inventory;
        current.state = previous.state;
        current.updated = previous.updated;
        if (previous.order === undefined) delete worldFeatures.winterGiftOrder;
        else worldFeatures.winterGiftOrder = previous.order;
        throw error;
      }
      updateHand();
      renderHUD();
      notify('CHRISTMAS SUPER-PACK: 2 GOLD BLOCKS AND 10 EMERALDS RECEIVED!');
    }
    const acknowledged = await requestAppleStore('ackBonus', worldID);
    if (acknowledged.owned && acknowledged.bonus.delivered) winterMessage = '';
  } catch (error) {
    winterMessage = appleStoreError(error).message;
  } finally {
    winterDelivering = false;
    renderWinterShop();
  }
}

if (appleStoreActive) {
  renderWinterShop = renderAppleStore;
  beginWinterCheckout = () => runApplePurchase('purchase');
  winterRestore = () => runApplePurchase('restore');
  initWinterAccount = refreshAppleStore;
  deliverWinterGift = deliverAppleWinterGift;
  for (const {buy} of winterCards) buy.onclick = beginWinterCheckout;
  for (const panel of document.querySelectorAll('.winterRecovery')) panel.remove();
  for (const id of ['winterEventShop', 'winterSkinShop']) {
    const restore = makeWinterButton('RESTORE PURCHASES', winterRestore);
    restore.className = 'secondary full';
    $(id).append(restore);
    appleRestoreButtons.push(restore);
  }
  const eventsBeforeApple = openEvents;
  openEvents = function (page, ...args) {
    const result = eventsBeforeApple(page, ...args);
    if (page === 'shop') refreshAppleStore();
    return result;
  };
  const skinsBeforeApple = openSkinGallery;
  openSkinGallery = function (...args) {
    const result = skinsBeforeApple(...args);
    refreshAppleStore();
    return result;
  };
  $('openSkins').onclick = openSkinGallery;
  window.addEventListener('corny-store-changed', () => refreshAppleStore(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAppleStore(true);
  });
  renderWinterShop();
  refreshAppleStore();
}
