// Vivaldi ignores chrome_url_overrides in private windows and opens a blank tab instead,
// so there a new tab is sent to our page by hand (the extension runs in split incognito mode)
const NEWTAB = chrome.runtime.getURL('newtab.html');

const NEW_TAB_URLS = [
  'chrome://newtab',
  'vivaldi://newtab',
  'chrome://vivaldi-webui/startpage',
  'vivaldi://startpage',
];

function isNewTab(tab, url) {
  if (url) return NEW_TAB_URLS.some(u => url.startsWith(u));
  // a tab with no address that no page opened: a plain new tab
  return tab.openerTabId === undefined;
}

function redirect(tab, url) {
  if (tab.incognito && isNewTab(tab, url)) chrome.tabs.update(tab.id, { url: NEWTAB });
}

chrome.tabs.onCreated.addListener(tab => redirect(tab, tab.pendingUrl || tab.url));

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url) redirect(tab, change.url);
});
