const page = document.getElementById('page');
const track = document.getElementById('track');
const dots = document.getElementById('dots');
const picker = document.getElementById('picker');
const tree = document.getElementById('folders');
const wallpaperInput = document.getElementById('wallpaper');
const wallpaperClear = document.getElementById('wallpaper-clear');
const info = document.getElementById('info');

const MAX_SIZE = 40;
const MIN_SIZE = 24;
const DOTS_BAR = 44;

// spaces: top-level folders used as spaces
// excluded: hidden folders (with all their contents) and bookmarks; everything else, new ones included, is shown
// active: current space
let spaces = null;
let excluded = null;
// collapsed: folders shown folded by default; a click on the page flips one just for now (toggled)
let collapsed = null;
const toggled = new Set();
let active = null;

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

function host(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function bookmarkBar() {
  const [root] = await chrome.bookmarks.getTree();
  return root.children[0];
}

const subfolders = folder => folder.children.filter(c => !c.url);
const links = folder => folder.children.filter(c => c.url);

async function loadSettings(bar) {
  const stored = await chrome.storage.local.get(['spaces', 'excluded', 'collapsed', 'active']);
  spaces = new Set(stored.spaces ?? subfolders(bar).map(f => f.id));
  excluded = new Set(stored.excluded ?? []);
  collapsed = new Set(stored.collapsed ?? []);
  active = stored.active ?? null;
}

function saveSettings() {
  chrome.storage.local.set({ spaces: [...spaces], excluded: [...excluded], collapsed: [...collapsed], active });
}

// Group tree (folder → visible links + subgroups); empty folders are skipped
function group(folder) {
  const shown = links(folder).filter(b => !excluded.has(b.id));
  const children = subfolders(folder).filter(f => !excluded.has(f.id)).map(group).filter(Boolean);
  if (!shown.length && !children.length) return null;
  return { id: folder.id, title: folder.title, links: shown, children };
}

// Space groups: its subfolders; loose bookmarks in it become a group named after the space
function groups(space) {
  const own = links(space).filter(b => !excluded.has(b.id));
  const out = own.length ? [{ id: space.id, title: space.title, links: own, children: [] }] : [];
  return out.concat(subfolders(space).filter(f => !excluded.has(f.id)).map(group).filter(Boolean));
}

// --- icon tint ---

const tints = new Map();

function dominantColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    // skip transparent and grey pixels, only saturated ones count
    const weight = (data[i + 3] / 255) * ((max - min) / 255);
    r += data[i] * weight;
    g += data[i + 1] * weight;
    b += data[i + 2] * weight;
    total += weight;
  }
  if (total < 2) return null;
  return `rgba(${r / total | 0}, ${g / total | 0}, ${b / total | 0}, 0.18)`;
}

function applyTint(img, icon) {
  const src = img.src;
  const set = tint => tint && icon.style.setProperty('--tint', tint);
  if (tints.has(src)) return set(tints.get(src));
  img.addEventListener('load', () => {
    tints.set(src, dominantColor(img));
    set(tints.get(src));
  }, { once: true });
}

// --- page ---

function item(bookmark) {
  const a = document.createElement('a');
  a.className = 'item';
  a.href = bookmark.url;
  a.title = bookmark.url;
  const icon = document.createElement('div');
  icon.className = 'icon';
  const img = document.createElement('img');
  img.src = favicon(bookmark.url);
  img.alt = '';
  applyTint(img, icon);
  icon.append(img);
  const label = document.createElement('span');
  label.textContent = bookmark.title || host(bookmark.url);
  a.append(icon, label);
  return a;
}

const isCollapsed = id => collapsed.has(id) !== toggled.has(id);

function list(links) {
  const el = document.createElement('div');
  el.className = 'list';
  el.append(...links.map(item));
  return el;
}

function count(g) {
  return g.links.length + g.children.reduce((n, c) => n + count(c), 0);
}

// Folder header with a chevron: a click folds or unfolds the folder (until the next new tab)
function header(tag, g, folder) {
  const h = document.createElement(tag);
  const chev = document.createElement('span');
  chev.className = 'chev';
  const n = document.createElement('span');
  n.className = 'count';
  n.textContent = count(g);
  h.append(chev, g.title, n);
  h.addEventListener('click', () => {
    toggled.has(g.id) ? toggled.delete(g.id) : toggled.add(g.id);
    folder.classList.toggle('collapsed', isCollapsed(g.id));
    fit();
  });
  return h;
}

// A folder's content: its bookmarks, then its subfolders nested the same way
function folderContent(el, tag, g) {
  el.classList.toggle('collapsed', isCollapsed(g.id));
  el.append(header(tag, g, el));
  if (g.links.length) el.append(list(g.links));
  el.append(...g.children.map(sub));
  return el;
}

function sub(g) {
  const el = document.createElement('div');
  el.className = 'sub';
  return folderContent(el, 'h3', g);
}

function section(g) {
  const el = document.createElement('section');
  el.className = 'group';
  return folderContent(el, 'h2', g);
}

let spaceList = [];

function renderDots() {
  document.getElementById('space-name').textContent = spaceList.find(f => f.id === active)?.title ?? '';
  dots.hidden = spaceList.length < 2;
  dots.replaceChildren(...spaceList.map(space => {
    const b = document.createElement('button');
    b.title = space.title;
    b.classList.toggle('active', space.id === active);
    b.addEventListener('click', () => go(space.id));
    return b;
  }));
}

function activeIndex() {
  return Math.max(0, spaceList.findIndex(f => f.id === active));
}

// --- pages ---
// Spaces sit side by side in the track; it slides to the active one with an ease-out (no bounce)

function slide() {
  track.classList.remove('leaning');
  track.style.transform = `translateX(${-activeIndex() * 100}%)`;
}

function go(id) {
  if (!id || id === active) return;
  active = id;
  saveSettings();
  renderDots();
  slide();
}

// --- trackpad swipe ---
// The page leans with the fingers; once the swipe passes SWIPE_SHARE of the width it slides
// to the next page right away. The rest of that swipe (and its momentum) is ignored, but a
// swipe the other way, a fresh push after the momentum dies down, or a short pause starts a new one.
const SWIPE_SHARE = 0.1;
const SWIPE_GAP = 120;
const LEAN = 0.4;

let swipeSum = 0;
let swipeDone = 0;
let lastWheel = 0;
let lastAbs = 0;
let leanTimer = null;

function lean(px) {
  clearTimeout(leanTimer);
  track.classList.add('leaning');
  track.style.transform = `translateX(calc(${-activeIndex() * 100}% - ${px * LEAN}px))`;
  leanTimer = setTimeout(() => { swipeSum = 0; slide(); }, SWIPE_GAP);
}

addEventListener('wheel', e => {
  if (!picker.hidden || spaceList.length < 2) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  const dir = Math.sign(e.deltaX);
  const abs = Math.abs(e.deltaX);
  const freshPush = abs > lastAbs * 1.5 + 2;
  if (e.timeStamp - lastWheel > SWIPE_GAP || (swipeDone && (dir !== swipeDone || freshPush))) swipeDone = 0;
  lastWheel = e.timeStamp;
  lastAbs = abs;
  if (swipeDone) return;
  if (Math.sign(swipeSum) !== dir) swipeSum = 0;
  const target = spaceList[activeIndex() + dir];
  // no page in that direction: nothing moves
  if (!target) return;
  swipeSum += e.deltaX;
  if (Math.abs(swipeSum) < track.clientWidth * SWIPE_SHARE) return lean(swipeSum);
  clearTimeout(leanTimer);
  swipeDone = dir;
  swipeSum = 0;
  // the slide starts from the leaned position, so the motion is continuous
  go(target.id);
}, { passive: false });

// Largest row size at which every page fits on screen (the track is as tall as the tallest page)
function fit() {
  for (let size = MAX_SIZE; size >= MIN_SIZE; size -= 1) {
    document.documentElement.style.setProperty('--size', size + 'px');
    if (info.offsetHeight + 20 + page.offsetHeight + DOTS_BAR <= innerHeight) return;
  }
}

function spacePage(space) {
  const el = document.createElement('div');
  el.className = 'space-page';
  const grid = document.createElement('div');
  grid.className = 'sections';
  grid.append(...groups(space).map(section));
  el.append(grid);
  return el;
}

async function render() {
  const bar = await bookmarkBar();
  if (!spaces) await loadSettings(bar);
  spaceList = subfolders(bar).filter(f => spaces.has(f.id));
  if (!spaceList.some(f => f.id === active)) active = spaceList[0]?.id ?? null;
  track.replaceChildren(...spaceList.map(spacePage));
  renderDots();
  fit();
  // first render jumps straight to the saved page, later ones slide
  if (!track.dataset.ready) {
    track.classList.add('leaning');
    track.style.transform = `translateX(${-activeIndex() * 100}%)`;
    track.offsetHeight;
    track.dataset.ready = '1';
  }
  slide();
  if (!picker.hidden) renderTree(bar);
}

// --- bookmark picker ---

function checkbox(id, checked, disabled, cls) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = cls;
  box.dataset.id = id;
  box.checked = checked;
  box.disabled = disabled;
  return box;
}

function bookmarkRow(bookmark, off) {
  const label = document.createElement('label');
  label.className = 'row';
  const box = checkbox(bookmark.id, !excluded.has(bookmark.id), off, 'pick');
  const icon = document.createElement('div');
  icon.className = 'icon';
  const img = document.createElement('img');
  img.src = favicon(bookmark.url);
  img.alt = '';
  applyTint(img, icon);
  icon.append(img);
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = bookmark.title || host(bookmark.url);
  const h = document.createElement('span');
  h.className = 'host';
  h.textContent = host(bookmark.url);
  label.append(box, icon, title, h);
  return label;
}

const hasExcluded = folder =>
  folder.children.some(c => excluded.has(c.id) || (!c.url && hasExcluded(c)));

// off = parent folder/space is disabled, so this item won't show anyway
function folderNode(folder, open, off, isSpace) {
  const details = document.createElement('details');
  details.open = open.has(folder.id);
  details.dataset.id = folder.id;
  const summary = document.createElement('summary');
  const on = isSpace ? spaces.has(folder.id) : !excluded.has(folder.id);
  const box = checkbox(folder.id, on, off, isSpace ? 'space' : 'pick');
  // on, but something inside is unchecked: shown as a minus
  if (on && hasExcluded(folder)) {
    box.indeterminate = true;
    box.dataset.mixed = '1';
  }
  const name = document.createElement('span');
  name.textContent = folder.title;
  summary.append(box, name);
  if (isSpace) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'space';
    summary.append(badge);
  } else {
    // whether this folder starts folded on the page
    const fold = document.createElement('button');
    fold.className = 'fold';
    fold.dataset.id = folder.id;
    fold.classList.toggle('on', collapsed.has(folder.id));
    fold.textContent = collapsed.has(folder.id) ? 'collapsed' : 'expanded';
    fold.title = 'Collapsed or expanded by default on the page';
    summary.append(fold);
  }
  // bookmarks and subfolders share one indented block under the folder name
  const children = document.createElement('div');
  children.className = 'children';
  for (const child of folder.children) {
    children.append(child.url ? bookmarkRow(child, off || !on) : folderNode(child, open, off || !on, false));
  }
  details.append(summary, children);
  return details;
}

let treeOpened = false;

function renderTree(bar) {
  const top = subfolders(bar);
  const open = treeOpened
    ? new Set([...tree.querySelectorAll('details[open]')].map(d => d.dataset.id))
    : new Set(top.map(f => f.id));
  treeOpened = true;
  tree.replaceChildren(...top.map(f => folderNode(f, open, false, true)));
}

tree.addEventListener('click', e => {
  // clicking a folder checkbox doesn't toggle the folder open/closed
  if (e.target.type === 'checkbox') e.stopPropagation();
  const fold = e.target.closest('.fold');
  if (!fold) return;
  e.preventDefault();
  const id = fold.dataset.id;
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
  toggled.delete(id);
  saveSettings();
  render();
});

tree.addEventListener('change', async e => {
  const box = e.target;
  const id = box.dataset.id;
  const isSpace = box.classList.contains('space');
  if (box.dataset.mixed) {
    // a click on the minus checks everything inside again
    const [folder] = await chrome.bookmarks.getSubTree(id);
    const clear = f => f.children?.forEach(c => { excluded.delete(c.id); clear(c); });
    clear(folder);
    isSpace ? spaces.add(id) : excluded.delete(id);
  } else if (isSpace) {
    box.checked ? spaces.add(id) : spaces.delete(id);
  } else {
    box.checked ? excluded.delete(id) : excluded.add(id);
  }
  saveSettings();
  render();
});

// --- clock ---

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

function tick() {
  const now = new Date();
  document.getElementById('time').textContent = timeFormat.format(now);
  document.getElementById('date').textContent = dateFormat.format(now);
}

tick();
setInterval(tick, 1000);

// --- weather (Open-Meteo, no API key) ---

const WEATHER_TTL = 30 * 60 * 1000;

const WEATHER_CODES = [
  [0, 'Clear'], [1, 'Mostly clear'], [2, 'Partly cloudy'], [3, 'Overcast'],
  [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'],
  [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorm'],
];

function describe(code) {
  return WEATHER_CODES.find(([max]) => code <= max)?.[1] ?? '';
}


// Open-Meteo returns local times like "2026-10-18T07:02"
const clockTime = iso => iso.slice(11, 16);

function showWeather(city, data) {
  const el = document.getElementById('weather');
  el.hidden = !city || !data;
  if (el.hidden) return fit();
  const { current, daily } = data;
  el.textContent = [
    `${Math.round(current.temperature_2m)}° ${describe(current.weather_code)}`,
    `↑${Math.round(daily.temperature_2m_max[0])}° ↓${Math.round(daily.temperature_2m_min[0])}°`,
    `rain ${daily.precipitation_probability_max[0] ?? 0}%`,
    city.name,
  ].join(' · ');
  el.title = `Sunrise ${clockTime(daily.sunrise[0])} · Sunset ${clockTime(daily.sunset[0])}`;
  fit();
}

async function fetchWeather(city) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', city.lat);
  u.searchParams.set('longitude', city.lon);
  u.searchParams.set('current', 'temperature_2m,weather_code');
  u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', '1');
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  return res.json();
}

// Cached data shows instantly; a fresh request only when it's older than WEATHER_TTL
async function updateWeather(force = false) {
  const { city, weather: cached } = await chrome.storage.local.get(['city', 'weather']);
  if (!city) return showWeather(null, null);
  // cache from before sunrise/sunset was added is ignored
  const weather = cached?.data.daily.sunrise ? cached : null;
  if (weather) showWeather(city, weather.data);
  if (!force && weather && Date.now() - weather.at < WEATHER_TTL) return;
  try {
    const data = await fetchWeather(city);
    chrome.storage.local.set({ weather: { at: Date.now(), data } });
    showWeather(city, data);
  } catch (e) {
    console.error(e);
  }
}

async function findCity(name) {
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', name);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'en');
  const res = await fetch(u);
  const place = (await res.json()).results?.[0];
  return place && { name: place.name, lat: place.latitude, lon: place.longitude };
}

const cityInput = document.getElementById('city-input');
const cityError = document.getElementById('city-error');

document.getElementById('city-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = cityInput.value.trim();
  cityError.hidden = true;
  if (!name) {
    await chrome.storage.local.remove(['city', 'weather']);
    return showWeather(null, null);
  }
  const city = await findCity(name).catch(() => null);
  if (!city) {
    cityError.textContent = `City "${name}" not found`;
    cityError.hidden = false;
    return;
  }
  cityInput.value = city.name;
  await chrome.storage.local.set({ city });
  updateWeather(true);
});

chrome.storage.local.get('city').then(({ city }) => { cityInput.value = city?.name ?? ''; });
updateWeather();
setInterval(updateWeather, WEATHER_TTL);

// --- wallpaper ---

// The same picture is set as the Vivaldi theme background, which covers the whole window.
// The page shows it sized to the window and shifted by the browser UI around the page
// (tabs and address bar above, side panel on the left), so both line up as one picture.
let wallpaperSize = null;

function alignWallpaper() {
  if (!wallpaperSize) return;
  const { width, height } = wallpaperSize;
  const scale = Math.max(outerWidth / width, outerHeight / height);
  const w = width * scale;
  const h = height * scale;
  const left = (outerWidth - w) / 2 - (outerWidth - innerWidth);
  const top = (outerHeight - h) / 2 - (outerHeight - innerHeight);
  document.body.style.backgroundSize = `${w}px ${h}px`;
  document.body.style.backgroundPosition = `${left}px ${top}px`;
}

function applyWallpaper(dataUrl) {
  document.body.classList.toggle('has-wallpaper', !!dataUrl);
  document.body.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  wallpaperClear.hidden = !dataUrl;
  wallpaperSize = null;
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    wallpaperSize = { width: img.naturalWidth, height: img.naturalHeight };
    alignWallpaper();
  };
  img.src = dataUrl;
}

addEventListener('resize', alignWallpaper);

wallpaperInput.addEventListener('change', () => {
  const file = wallpaperInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    chrome.storage.local.set({ wallpaper: reader.result });
    applyWallpaper(reader.result);
  };
  reader.readAsDataURL(file);
  wallpaperInput.value = '';
});

wallpaperClear.addEventListener('click', () => {
  chrome.storage.local.remove('wallpaper');
  applyWallpaper(null);
});

chrome.storage.local.get('wallpaper').then(({ wallpaper }) => applyWallpaper(wallpaper));

document.getElementById('all').addEventListener('click', () => {
  chrome.tabs.update({ url: 'vivaldi://bookmarks' });
});

document.getElementById('edit').addEventListener('click', async () => {
  picker.hidden = false;
  renderTree(await bookmarkBar());
});

document.getElementById('close').addEventListener('click', () => { picker.hidden = true; });
picker.addEventListener('click', e => { if (e.target === picker) picker.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') picker.hidden = true; });

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
  chrome.bookmarks[ev].addListener(render);
}

addEventListener('resize', fit);

render();
