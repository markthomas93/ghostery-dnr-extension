importScripts('../vendor/tldts/index.umd.min.js'); // exports `tldts`
importScripts('../vendor/@cliqz/adblocker/adblocker.umd.min.js'); // exports `adblocker`

const { parse } = tldts;
const { FiltersEngine } = adblocker;

const adblockerEngines = {
  "ads": null,
  "tracking": null,
  "annoyances": null,
};

const adblockerStartupPromise = (async function () {
  await Promise.all(Object.keys(adblockerEngines).map(async (engineName) => {
    const response = await fetch(chrome.runtime.getURL(`adblocker_engines/dnr-${engineName}-cosmetics.engine.bytes`));
    const engineBytes = await response.arrayBuffer();
    const engine = FiltersEngine.deserialize(new Uint8Array(engineBytes));
    adblockerEngines[engineName] = engine;
  }));
})();

async function adblockerInjectStylesWebExtension(
  styles,
  {
    tabId,
    frameId,
    allFrames = false,
  }
) {
  // Abort if stylesheet is empty.
  if (styles.length === 0) {
    return;
  }

  // Proceed with stylesheet injection.
  return new Promise((resolve) => {
    const target = {
      tabId,
    };

    if (frameId) {
      target.frameIds = [frameId];
    } else {
      target.allFrames = allFrames;
    }

    chrome.scripting.insertCSS({
      css: styles,
      origin: 'USER',
      target,
    }, () => resolve);
  });
}

// copied from https://github.com/cliqz-oss/adblocker/blob/0bdff8559f1c19effe278b8982fb8b6c33c9c0ab/packages/adblocker-webextension/adblocker.ts#L297
async function adblockerOnMessage(msg, sender, sendResponse) {
  if (msg.action === 'getCosmeticsFilters') {
    await adblockerStartupPromise;

    const genericStyles = [];
    const specificStyles = [];
    let specificFrameId = null;
    const specificResponses = [];

    Object.keys(adblockerEngines).forEach(engineName => {
      // Extract hostname from sender's URL
      const { url = '', frameId } = sender;
      const parsed = parse(url);
      const hostname = parsed.hostname || '';
      const domain = parsed.domain || '';
      // Once per tab/page load we inject base stylesheets. These are always
      // the same for all frames of a given page because they do not depend on
      // a particular domain and cannot be cancelled using unhide rules.
      // Because of this, we specify `allFrames: true` when injecting them so
      // that we do not need to perform this operation for sub-frames.
      if (frameId === 0 && msg.lifecycle === 'start') {
        const { active, styles } = adblockerEngines.ads.getCosmeticsFilters({
          domain,
          hostname,
          url,

          classes: msg.classes,
          hrefs: msg.hrefs,
          ids: msg.ids,

          // This needs to be done only once per tab
          getBaseRules: true,
          getInjectionRules: false,
          getExtendedRules: false,
          getRulesFromDOM: false,
          getRulesFromHostname: false,
        });

        if (active === false) {
          return;
        }

        genericStyles.push(styles);
      }

      // Separately, requests cosmetics which depend on the page it self
      // (either because of the hostname or content of the DOM). Content script
      // logic is responsible for returning information about lists of classes,
      // ids and hrefs observed in the DOM. MutationObserver is also used to
      // make sure we can react to changes.
      {
        const { active, styles, scripts, extended } = adblockerEngines.ads.getCosmeticsFilters({
          domain,
          hostname,
          url,

          classes: msg.classes,
          hrefs: msg.hrefs,
          ids: msg.ids,

          // This needs to be done only once per frame
          getBaseRules: false,
          getInjectionRules: msg.lifecycle === 'start',
          getExtendedRules: msg.lifecycle === 'start',
          getRulesFromHostname: msg.lifecycle === 'start',

          // This will be done every time we get information about DOM mutation
          getRulesFromDOM: msg.lifecycle === 'dom-update',
        });

        if (active === false) {
          return;
        }

        specificStyles.push(styles, { tabId: sender.tab.id, frameId });
        specificFrameId = frameId;

        // Inject scripts from content script
        if (scripts.length !== 0) {
          specificResponses.push({
            active,
            extended,
            scripts,
          });
        }
      }
    });

    if (genericStyles.length > 0) {
      adblockerInjectStylesWebExtension(genericStyles.join('\n'), {
        tabId: sender.tab.id,
        allFrames: true,
      });
    }

    if (specificStyles.length > 0) {
      adblockerInjectStylesWebExtension(specificStyles.join('\n'), {
        tabId: sender.tab.id,
        frameId: specificFrameId,
      });
    }

    if (specificResponses.length > 0) {
      sendResponse({
        active: specificResponses.map(r => r.active).some(a => a),
        extended: specificResponses.map(r => r.extended).flat(),
        scripts: specificResponses.map(r => r.scripts).flat(),
        styles: '',
      });
    }
  }
}
